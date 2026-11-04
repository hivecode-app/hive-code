import 'package:agent_company/l10n/ui_copy.dart';
// Dictation through dictate-server (the owner's Hebrew transcription service, ~/projects/dictate-server).
// API: POST <base>/transcribe, multipart `audio` (16 kHz mono 16-bit WAV) + `engine`,
// `Authorization: Bearer <token>` -> {"text", "ms", "engine"}. 401 on a bad token, 502 when the
// upstream model fails.
//
// Where the app reaches it:
//   1. DICTATE_URL (+ DICTATE_TOKEN) baked in at build time: straight to the service.
//   2. Otherwise through hq: POST <hq>/api/dictate/transcribe with this device's own token (#54).
//      hq checks it like on every route and forwards to dictate-server with its own credential, so no
//      dictate-server token ships inside the app and a device that is not paired gets 401.
// The text lands in the composer for editing; nothing here sends a message.
//
// A recording is never lost to a failed transcription (DictationJobs): it is saved on the device
// before anything goes out, and goes in pieces of about a minute, each its own request. On a phone
// the upload is the slow part: 109 s of PCM once took over two minutes to leave the phone, past the
// single 45 s timeout this used to have, and the text came back to nobody. A piece that fails keeps
// the recording, and "נסה שוב" sends only what was not transcribed yet.
import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:record/record.dart';

import '../model/company_time.dart';

import 'auth_client.dart';
import 'backend_select.dart';
import 'dictation_files.dart';

const kDictateUrl = String.fromEnvironment('DICTATE_URL');
const kDictateToken = String.fromEnvironment('DICTATE_TOKEN');
const kDictateRate = 16000;
String get kMicFailed => UiCopy.text(786);

/// A failure already worded for the owner. [fault]: ours or the service's, so it goes to hq
/// (error_report.dart); not so for one that is his to fix (a permission, a recording too short).
class DictationError implements Exception {
  const DictationError(String message, {this.fault = true}) : _message = message, copyId = null; // ignore: prefer_initializing_formals
  const DictationError.localized(this.copyId, {this.fault = true}) : _message = null;
  final String? _message;
  final int? copyId;
  String get message => copyId == null ? _message! : UiCopy.text(copyId!);
  final bool fault;
  @override
  String toString() => message;
}

/// The microphone: raw 16 kHz mono PCM16 in, one buffer out.
abstract class Recorder {
  /// Starts recording. Throws [DictationError] when there is no permission or no microphone.
  Future<void> start();

  /// Stops and returns everything recorded since [start].
  Future<Uint8List> stop();

  Future<void> cancel();
}

/// The `record` plugin, streaming PCM so Android and the web behave the same.
class MicRecorder implements Recorder {
  AudioRecorder? _rec;
  StreamSubscription<Uint8List>? _sub;
  final _pcm = BytesBuilder(copy: false);
  bool _broken = false;

  @override
  Future<void> start() async {
    final rec = _rec ??= AudioRecorder();
    final bool allowed;
    try {
      allowed = await rec.hasPermission();
    } catch (_) {
      throw const DictationError.localized(786);
    }
    if (!allowed) throw  DictationError.localized(787, fault: false);
    await _sub?.cancel();
    _pcm.clear();
    _broken = false;
    try {
      final stream = await rec.startStream(const RecordConfig(encoder: AudioEncoder.pcm16bits, sampleRate: kDictateRate, numChannels: 1));
      _sub = stream.listen(_pcm.add, onError: (_) => _broken = true);
    } catch (_) {
      throw const DictationError.localized(786);
    }
  }

  @override
  Future<Uint8List> stop() async {
    await _rec?.stop();
    await _sub?.cancel();
    _sub = null;
    final pcm = _pcm.takeBytes();
    // Half a dictation is worse than none: the owner would send it without noticing the gap.
    if (_broken) throw const DictationError.localized(786);
    return pcm;
  }

  @override
  Future<void> cancel() async {
    await _rec?.cancel();
    await _sub?.cancel();
    _sub = null;
    _pcm.clear();
  }
}

/// Wraps raw PCM16 mono in a WAV header, the format dictate-server expects.
Uint8List wavFromPcm(Uint8List pcm, {int rate = kDictateRate}) {
  final h = ByteData(44);
  void tag(int at, String s) {
    for (var i = 0; i < 4; i++) {
      h.setUint8(at + i, s.codeUnitAt(i));
    }
  }

  tag(0, 'RIFF');
  h.setUint32(4, 36 + pcm.length, Endian.little);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  h.setUint32(16, 16, Endian.little); // fmt chunk size
  h.setUint16(20, 1, Endian.little); // PCM
  h.setUint16(22, 1, Endian.little); // mono
  h.setUint32(24, rate, Endian.little);
  h.setUint32(28, rate * 2, Endian.little); // byte rate
  h.setUint16(32, 2, Endian.little); // block align
  h.setUint16(34, 16, Endian.little); // bits per sample
  tag(36, 'data');
  h.setUint32(40, pcm.length, Endian.little);
  return (BytesBuilder(copy: false)
        ..add(h.buffer.asUint8List())
        ..add(pcm))
      .takeBytes();
}

class DictateClient {
  DictateClient({required this.baseUrl, required this.token, http.Client? client, this.engine = 'openai'})
      : _http = client ?? http.Client(),
        _session = null;

  /// Through hq with this device's own token. The saved session is read on every recording, so a
  /// device that signs in or out after the app started is picked up.
  DictateClient.viaHq(Future<Session?> Function() session, {http.Client? client, this.engine = 'openai'})
      : baseUrl = '',
        token = '',
        _http = client ?? http.Client(),
        _session = session;

  final String baseUrl;
  final String token;
  final String engine;
  final http.Client _http;
  final Future<Session?> Function()? _session;

  /// The configured service, or null when this build has no way to reach it.
  static DictateClient? configured() {
    if (kDictateUrl.isNotEmpty) return DictateClient(baseUrl: kDictateUrl, token: kDictateToken);
    // Through the hq this device is signed in to, whichever server that is (_target says so when none).
    return DictateClient.viaHq(savedSession);
  }

  /// Where to post and with which token: the build's service, or `<hq>/api/dictate` with the device token.
  Future<(String, String)> _target() async {
    final get = _session;
    if (get == null) return (baseUrl, token);
    final s = await get();
    if (s == null) throw  DictationError.localized(788, fault: false);
    final hq = s.baseUrl.endsWith('/') ? s.baseUrl.substring(0, s.baseUrl.length - 1) : s.baseUrl;
    return ('$hq/api/dictate', s.token);
  }

  /// No upload progress for this long: the connection is gone.
  static const stallTimeout = Duration(seconds: 30);

  /// From the last byte sent to the answer: dictate-server takes a few seconds for a minute of audio.
  static const answerTimeout = Duration(seconds: 90);

  /// Sends the WAV and returns the Hebrew text. Throws [DictationError].
  Future<String> transcribe(Uint8List wav, {void Function(double sent)? onProgress}) async {
    final text = await transcribePart(wav, onProgress: onProgress);
    if (text.isEmpty) throw kNoSpeech;
    return text;
  }

  /// [transcribe] for one piece of a longer recording, where silence is '' and not an error.
  /// [onProgress]: the share of the WAV that has left the device, 0..1.
  Future<String> transcribePart(Uint8List wav, {void Function(double sent)? onProgress}) async {
    final (url, bearer) = await _target();
    final base = url.endsWith('/') ? url.substring(0, url.length - 1) : url;
    final uri = Uri.parse('$base/transcribe');
    final abort = Completer<void>();
    Timer? timer;
    void arm(Duration d) {
      timer?.cancel();
      timer = Timer(d, () {
        if (!abort.isCompleted) abort.complete();
      });
    }

    final http.Response r;
    try {
      final form = http.MultipartRequest('POST', uri)
        ..fields['engine'] = engine
        ..files.add(http.MultipartFile.fromBytes('audio', wav, filename: 'audio.wav'));
      final body = await form.finalize().toBytes();
      final req = _Upload(uri, body, abort.future, (sent) {
        onProgress?.call(body.isEmpty ? 1 : sent / body.length);
        arm(sent < body.length ? stallTimeout : answerTimeout);
      })
        ..headers.addAll(form.headers)
        ..headers['authorization'] = 'Bearer $bearer';
      arm(stallTimeout);
      r = await http.Response.fromStream(await _http.send(req));
    } catch (_) {
      if (!abort.isCompleted) abort.complete();
      throw  DictationError.localized(789);
    } finally {
      timer?.cancel();
    }
    if (r.statusCode == 401 && _session != null) throw  DictationError.localized(790);
    if (r.statusCode == 401) throw  DictationError.localized(791);
    if (r.statusCode != 200) throw  DictationError.localized(792);
    try {
      return ((jsonDecode(utf8.decode(r.bodyBytes)) as Map)['text'] as String? ?? '').trim();
    } catch (_) {
      throw  DictationError.localized(793);
    }
  }
}

const kNoSpeech = DictationError.localized(794, fault: false);

/// The multipart body handed to the socket a slice at a time, so [_sent] tracks what has left the
/// device (the socket pulls the next slice only when it has room) and the stall timer sees a slow
/// upload that is still moving. The web client reads it all at once, so there it jumps to 100%.
class _Upload extends http.BaseRequest implements http.Abortable {
  _Upload(Uri url, this._body, this.abortTrigger, this._sent) : super('POST', url) {
    contentLength = _body.length;
  }

  final Uint8List _body;
  final void Function(int sent) _sent;
  @override
  final Future<void>? abortTrigger;

  static const _slice = 16 * 1024;

  @override
  http.ByteStream finalize() {
    super.finalize();
    return http.ByteStream(_slices());
  }

  Stream<List<int>> _slices() async* {
    for (var at = 0; at < _body.length; at += _slice) {
      final end = at + _slice < _body.length ? at + _slice : _body.length;
      yield Uint8List.sublistView(_body, at, end);
      _sent(end);
    }
    if (_body.isEmpty) _sent(0);
  }
}

/// About a minute a piece: each is its own request, well inside every timeout on the way (hq and
/// dictate-server wait 60 s on dictate-server and on OpenAI), and a failure costs one piece, not the lot.
const kPieceSeconds = 60;

/// Cuts PCM16 mono into pieces of at most [seconds], each cut at the quietest 100 ms in the last
/// 10 s before the limit, so a cut rarely lands inside a word.
List<Uint8List> splitPcm(Uint8List pcm, {int seconds = kPieceSeconds, int rate = kDictateRate}) {
  final perSec = rate * 2;
  final frame = perSec ~/ 10;
  final max = seconds * perSec;
  final out = <Uint8List>[];
  final b = ByteData.sublistView(pcm);
  var from = 0;
  while (pcm.length - from > max) {
    var cut = from + max;
    var quietest = -1;
    final window = from + max - 10 * perSec;
    for (var at = window > from ? window : from; at + frame <= from + max; at += frame) {
      var sum = 0;
      for (var i = at; i < at + frame; i += 2) {
        sum += b.getInt16(i, Endian.little).abs();
      }
      if (quietest < 0 || sum < quietest) {
        quietest = sum;
        cut = (at + frame ~/ 2) & ~1; // on a sample, whatever the rate
      }
    }
    out.add(Uint8List.sublistView(pcm, from, cut));
    from = cut;
  }
  out.add(Uint8List.sublistView(pcm, from));
  return out;
}

/// A recording kept on the device until all of it is transcribed. [texts]: one per piece, null
/// while that piece is not done.
class PendingDictation {
  PendingDictation({required this.id, required this.identityId, required this.at, required this.seconds, required this.texts, this.pcm});
  final String id;
  final String identityId;
  final DateTime at;
  final int seconds;
  final List<String?> texts;
  Uint8List? pcm;

  /// Saved in the app's storage, so it outlives the app; false on the web, or when saving failed.
  bool onDisk = false;

  /// Every piece is text: it waits only for the composer of its chat to take it ([DictationJobs.take]).
  bool get done => texts.every((t) => t != null);

  /// Set while it goes out: which piece (from 0), and how much of it has left the device.
  bool running = false;
  int piece = 0;
  double sent = 0;
  DateTime? startedAt;

  /// The last failure, worded for the owner; null before the first try and while running.
  String? error;

  int get pieces => texts.length;

  String toJson() => jsonEncode({'identity': identityId, 'at': at.millisecondsSinceEpoch, 'seconds': seconds, 'texts': texts});

  static PendingDictation? fromJson(String id, String raw) {
    try {
      final m = jsonDecode(raw) as Map;
      return PendingDictation(
        id: id,
        identityId: m['identity'] as String,
        at: DateTime.fromMillisecondsSinceEpoch(m['at'] as int),
        seconds: m['seconds'] as int,
        texts: [for (final t in m['texts'] as List) t as String?],
      )..onDisk = true;
    } catch (_) {
      return null;
    }
  }
}

/// Every recording not yet in a composer, here and on disk. The composer shows the ones of its chat:
/// progress while one runs, "לנסות שוב" when it is not running, also after the app was closed and
/// opened. A recording is deleted only when the composer of its own chat takes its text ([take]), so
/// leaving the chat, switching chats or closing the app before then loses nothing.
class DictationJobs extends ChangeNotifier {
  DictationJobs(this.files);
  final DictationFiles files;
  final List<PendingDictation> pending = [];
  Future<void>? _loaded;
  var _seq = 0;

  /// Reads what an earlier run of the app left. Safe to call from every composer.
  Future<void> load() => _loaded ??= () async {
        try {
          for (final MapEntry(:key, :value) in (await files.list()).entries) {
            final p = PendingDictation.fromJson(key, value);
            if (p != null && !pending.any((q) => q.id == key)) pending.add(p);
          }
        } catch (_) {
          // No storage (tests, a broken directory): what this run records still waits in memory.
        }
        pending.sort((a, b) => a.at.compareTo(b.at));
        notifyListeners();
      }();

  List<PendingDictation> of(String identityId) => [for (final p in pending) if (p.identityId == identityId) p];

  /// Keeps [pcm] before anything is sent.
  Future<PendingDictation> add(String identityId, Uint8List pcm) async {
    final now = CompanyTime.now();
    final p = PendingDictation(
      id: '${now.millisecondsSinceEpoch}-${_seq++}',
      identityId: identityId,
      at: now,
      seconds: pcm.length ~/ (kDictateRate * 2),
      texts: List.filled(splitPcm(pcm).length, null),
      pcm: pcm,
    );
    pending.add(p);
    try {
      await files.write(p.id, p.toJson(), pcm: pcm);
      p.onDisk = files is! MemoryDictationFiles;
    } catch (_) {
      // Not on disk, still in memory: a retry works until the app closes, and the strip says so.
    }
    notifyListeners();
    return p;
  }

  /// Transcribes the pieces not done yet; then the text waits for [take]. On a failure the recording
  /// stays, with what was done so far, and the [DictationError] is rethrown.
  Future<void> run(PendingDictation p, DictateClient client) async {
    if (p.running) throw StateError('already running');
    p
      ..running = true
      ..error = null
      ..startedAt = CompanyTime.now()
      ..sent = 0;
    notifyListeners();
    try {
      final pcm = p.pcm ??= await files.pcm(p.id);
      if (pcm == null) {
        await _drop(p);
        throw  DictationError.localized(795, fault: false);
      }
      final parts = splitPcm(pcm);
      for (var i = 0; i < parts.length; i++) {
        if (i < p.texts.length && p.texts[i] != null) continue;
        p
          ..piece = i
          ..sent = 0;
        notifyListeners();
        final text = await client.transcribePart(wavFromPcm(parts[i]), onProgress: (s) {
          p.sent = s;
          notifyListeners();
        });
        p.texts[i] = text;
        try {
          await files.write(p.id, p.toJson());
        } catch (_) {}
      }
      if (p.texts.every((t) => t!.isEmpty)) {
        await _drop(p);
        throw kNoSpeech;
      }
    } on DictationError catch (e) {
      p.error = e.message;
      rethrow;
    } catch (_) {
      p.error = UiCopy.text(796);
      throw  DictationError.localized(797);
    } finally {
      p.running = false;
      notifyListeners();
    }
  }

  /// The text of this chat's finished recordings, oldest first, and they are deleted; null: none.
  String? take(String identityId) {
    final ready = [for (final p in of(identityId)) if (p.done && !p.running) p];
    if (ready.isEmpty) return null;
    for (final p in ready) {
      unawaited(_drop(p));
    }
    return [for (final p in ready) ...p.texts.whereType<String>().where((t) => t.isNotEmpty)].join(' ');
  }

  /// Deletes it (his choice).
  Future<void> discard(PendingDictation p) => _drop(p);

  Future<void> _drop(PendingDictation p) async {
    pending.remove(p);
    notifyListeners();
    try {
      await files.delete(p.id);
    } catch (_) {}
  }
}

/// What the composer's mic uses. Tests swap it.
class Dictation {
  Dictation({required this.recorder, required this.client, DictationJobs? jobs}) : jobs = jobs ?? DictationJobs(MemoryDictationFiles());
  final Recorder recorder;
  final DictateClient? client;
  final DictationJobs jobs;

  static Dictation? _instance;
  static Dictation get instance => _instance ??= Dictation(recorder: MicRecorder(), client: DictateClient.configured(), jobs: DictationJobs(DictationFiles.device()));
  static set instance(Dictation d) => _instance = d;
}
