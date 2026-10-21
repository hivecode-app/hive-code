// error-catcher, the app's part (22/10/2026): every error shown to him goes to hq by itself
// (POST /api/client-errors, packages/hq/src/api.ts), with the app's version, the screen and a stack.
// hq groups them and asks him, one card per fault, "לטפל" / "לא עכשיו" (error-watch.ts).
// Without a link the report waits in a queue kept on the device and goes when hq answers again,
// like the outbox of messages. Errors hq sees for itself (a turn that ended in an error, a message
// not delivered) are not sent from here: they would be a second card for the same fault.
import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../model/company_time.dart' as company_time;

/// Sends one report; the HTTP status (0: it did not reach hq).
typedef ErrorPost = Future<int> Function(Map<String, dynamic> body);

const kErrorQueueKey = 'client_errors';

class ErrorReports {
  ErrorReports({this.max = 50, this.repeatAfter = const Duration(minutes: 10)});

  static final instance = ErrorReports();

  /// Kept on the device at most; the oldest go first.
  final int max;

  /// The same error again sooner than this is not sent again: hq already counts it.
  final Duration repeatAfter;

  ErrorPost? _post;
  SharedPreferences? _prefs;
  final List<Map<String, dynamic>> _queue = [];
  final Map<String, DateTime> _last = {};
  Future<void>? _loading;
  Future<void> _chain = Future.value();
  Timer? _retry;
  int _step = 0;

  /// "android 42", "web": the build that showed it.
  String appVersion = kIsWeb ? 'web' : defaultTargetPlatform.name;

  /// Where he is when no screen is given (the shell sets it from the tab).
  String Function()? screenOf;

  /// Signed in to hq: what is shown is sent ("נשלח לטיפול" next to it).
  bool get active => _post != null;

  @visibleForTesting
  List<Map<String, dynamic>> get queued => List.unmodifiable(_queue);

  /// The backend that can send. Sends what waited.
  void attach(ErrorPost post) {
    _post = post;
    _step = 0;
    unawaited(flush());
  }

  void detach(ErrorPost post) {
    if (_post != post) return; // a backend that was already replaced: the new one's retry stays
    _post = null;
    _retry?.cancel();
    _retry = null;
  }

  /// An error shown to him: on its way to hq, or in the queue until there is a link.
  /// [kind]: bar (the app's error bar), screen (an error on a screen), stuck (loading for too long),
  /// flutter / uncaught (a crash in the app itself).
  void reportShown(String kind, String message, {String? screen, String? stack}) {
    final m = message.trim();
    if (m.isEmpty) return;
    final where = screen ?? _screen();
    final key = '$kind|$where|$m';
    final now = company_time.CompanyTime.now();
    final last = _last[key];
    if (last != null && now.difference(last) < repeatAfter) return;
    _last[key] = now;
    _queue.add({
      'kind': kind,
      'message': _clip(m, 1000),
      'screen': _clip(where, 80),
      'app_version': appVersion,
      'stack': _clip(stack ?? StackTrace.current.toString(), 4000),
      'shown': kind != 'flutter' && kind != 'uncaught',
      'at': now.millisecondsSinceEpoch,
    });
    if (_queue.length > max) _queue.removeRange(0, _queue.length - max);
    unawaited(flush());
  }

  String _screen() {
    try {
      return screenOf?.call() ?? '';
    } catch (_) {
      return '';
    }
  }

  static String _clip(String s, int n) => s.length <= n ? s : s.substring(0, n);

  Future<SharedPreferences?> _store() async {
    if (_prefs != null) return _prefs;
    try {
      _prefs = await SharedPreferences.getInstance();
    } catch (_) {
      // Tests without a mock store: the queue lives in memory.
    }
    return _prefs;
  }

  /// What waited from the last run joins the queue, ahead of anything new.
  Future<void> _load() => _loading ??= _read();

  Future<void> _read() async {
    final raw = (await _store())?.getString(kErrorQueueKey);
    if (raw == null) return;
    try {
      _queue.insertAll(0, (jsonDecode(raw) as List).cast<Map<String, dynamic>>());
    } catch (_) {}
    if (_queue.length > max) _queue.removeRange(0, _queue.length - max);
  }

  Future<void> _save() async {
    final p = await _store();
    if (p == null) return;
    if (_queue.isEmpty) {
      await p.remove(kErrorQueueKey);
    } else {
      await p.setString(kErrorQueueKey, jsonEncode(_queue));
    }
  }

  /// Sends the queue in order, one run after the other (and keeps it on the device). One hq takes
  /// (or refuses for good) leaves the queue; one that does not reach it waits, with what is behind
  /// it, and goes again: 30s, 1, 2, 5 minutes.
  Future<void> flush() => _chain = _chain.then((_) => _send()).catchError((Object _) {});

  Future<void> _send() async {
    await _load();
    final post = _post;
    var wait = false;
    while (post != null && _queue.isNotEmpty && _post == post) {
      final e = _queue.first;
      final body = Map<String, dynamic>.of(e)..remove('at');
      // Queued before the version was known (a crash at start): the version now.
      if ((body['app_version'] as String? ?? '').isEmpty) body['app_version'] = appVersion;
      int code;
      try {
        code = await post(body);
      } catch (_) {
        code = 0;
      }
      if (code == 0 || code == 429 || code >= 500) {
        wait = true;
        break;
      }
      _queue.remove(e);
      _step = 0;
    }
    await _save();
    if (wait && _post == post && _retry == null) {
      final secs = [30, 60, 120, 300][_step.clamp(0, 3)];
      _step++;
      _retry = Timer(Duration(seconds: secs), () {
        _retry = null;
        unawaited(flush());
      });
    }
  }

  /// FlutterError.onError and PlatformDispatcher.onError: a crash in the app is a report too.
  /// What was there before still runs (the console, the red screen in debug).
  void catchCrashes() {
    final before = FlutterError.onError;
    FlutterError.onError = (d) {
      reportShown('flutter', d.exceptionAsString(), stack: d.stack?.toString() ?? '');
      before?.call(d);
    };
    final dispatcher = PlatformDispatcher.instance;
    final prev = dispatcher.onError;
    dispatcher.onError = (e, st) {
      reportShown('uncaught', e.toString(), stack: st.toString());
      return prev?.call(e, st) ?? false;
    };
  }

  @visibleForTesting
  void reset() {
    _post = null;
    _queue.clear();
    _last.clear();
    _loading = null;
    _prefs = null;
    _retry?.cancel();
    _retry = null;
    _step = 0;
    _chain = Future.value();
    screenOf = null;
  }
}

/// hq's card for a fault it caught (error-watch.ts): asked by the system, its ask id `err-…`.
bool isCaughtFault(String? from, String? askId) => from == 'hq' && (askId?.startsWith('err-') ?? false);

/// The one way to say an error was shown (ErrorReports.instance).
void reportShown(String kind, String message, {String? screen, String? stack}) =>
    ErrorReports.instance.reportShown(kind, message, screen: screen, stack: stack);
