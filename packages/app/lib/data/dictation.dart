// Dictation through dictate-server (the owner's Hebrew transcription service, ~/projects/dictate-server).
// API: POST <base>/transcribe, multipart `audio` (16 kHz mono 16-bit WAV) + `engine`,
// `Authorization: Bearer <token>` -> {"text", "ms", "engine"}. 401 on a bad token, 502 when the
// upstream model fails.
//
// Where the app reaches it:
//   1. DICTATE_URL (+ DICTATE_TOKEN) baked in at build time: straight to the service.
//   2. Otherwise the app's gateway, next to hq's: `<app path>/dictate` on the web, HQ_URL with
//      `/hq` -> `/dictate` on Android. Caddy adds the service's token there, the same way it does
//      for hq (deploy/caddy/app-dictate.caddy), so the token never ships inside the app.
// The text lands in the composer for editing; nothing here sends a message.
import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;
import 'package:record/record.dart';

import 'backend_select.dart';

const kDictateUrl = String.fromEnvironment('DICTATE_URL');
const kDictateToken = String.fromEnvironment('DICTATE_TOKEN');
const kDictateRate = 16000;
const kMicFailed = 'לא הצלחתי להקליט מהמיקרופון. אפשר להכתיב דרך המיקרופון שבמקלדת.';

/// A failure already worded for the owner.
class DictationError implements Exception {
  const DictationError(this.message);
  final String message;
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
      throw const DictationError(kMicFailed);
    }
    if (!allowed) throw const DictationError('אין הרשאה למיקרופון. אפשר לאשר אותה בהגדרות המכשיר ולנסות שוב.');
    await _sub?.cancel();
    _pcm.clear();
    _broken = false;
    try {
      final stream = await rec.startStream(const RecordConfig(encoder: AudioEncoder.pcm16bits, sampleRate: kDictateRate, numChannels: 1));
      _sub = stream.listen(_pcm.add, onError: (_) => _broken = true);
    } catch (_) {
      throw const DictationError(kMicFailed);
    }
  }

  @override
  Future<Uint8List> stop() async {
    await _rec?.stop();
    await _sub?.cancel();
    _sub = null;
    final pcm = _pcm.takeBytes();
    // Half a dictation is worse than none: the owner would send it without noticing the gap.
    if (_broken) throw const DictationError(kMicFailed);
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
  DictateClient({required this.baseUrl, required this.token, http.Client? client, this.engine = 'openai'}) : _http = client ?? http.Client();

  final String baseUrl;
  final String token;
  final String engine;
  final http.Client _http;

  /// The configured service, or null when this build has no way to reach it.
  static DictateClient? configured() {
    if (kDictateUrl.isNotEmpty) return DictateClient(baseUrl: kDictateUrl, token: kDictateToken);
    final gw = gatewayUrl();
    if (!gw.endsWith('/hq')) return null;
    return DictateClient(baseUrl: '${gw.substring(0, gw.length - 3)}/dictate', token: kGatewayToken);
  }

  /// Sends the WAV and returns the Hebrew text. Throws [DictationError].
  Future<String> transcribe(Uint8List wav) async {
    final http.Response r;
    try {
      final base = baseUrl.endsWith('/') ? baseUrl.substring(0, baseUrl.length - 1) : baseUrl;
      final req = http.MultipartRequest('POST', Uri.parse('$base/transcribe'))
        ..headers['authorization'] = 'Bearer $token'
        ..fields['engine'] = engine
        ..files.add(http.MultipartFile.fromBytes('audio', wav, filename: 'audio.wav'));
      r = await http.Response.fromStream(await _http.send(req).timeout(const Duration(seconds: 45)));
    } catch (_) {
      throw const DictationError('אין חיבור לשירות ההכתבה, ולכן ההקלטה לא תומללה. אפשר לנסות שוב.');
    }
    if (r.statusCode == 401) throw const DictationError('שירות ההכתבה לא קיבל את הטוקן, ולכן ההקלטה לא תומללה.');
    if (r.statusCode != 200) throw const DictationError('שירות ההכתבה לא הצליח לתמלל את ההקלטה. אפשר לנסות שוב.');
    final String text;
    try {
      text = ((jsonDecode(utf8.decode(r.bodyBytes)) as Map)['text'] as String? ?? '').trim();
    } catch (_) {
      throw const DictationError('שירות ההכתבה החזיר תשובה לא צפויה. אפשר לנסות שוב.');
    }
    if (text.isEmpty) throw const DictationError('לא נשמע דיבור בהקלטה. אפשר לנסות שוב.');
    return text;
  }
}

/// What the composer's mic uses. Tests swap it.
class Dictation {
  Dictation({required this.recorder, required this.client});
  final Recorder recorder;
  final DictateClient? client;

  static Dictation? _instance;
  static Dictation get instance => _instance ??= Dictation(recorder: MicRecorder(), client: DictateClient.configured());
  static set instance(Dictation d) => _instance = d;
}
