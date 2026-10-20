// flutter drive host side: saves screenshots and timeline summaries the device test reports.
// QA_OUT (default /tmp/qa-device) is where they go.
import 'dart:io';

import 'package:flutter_driver/flutter_driver.dart';
import 'package:integration_test/integration_test_driver_extended.dart';

Future<void> main() async {
  final out = Platform.environment['QA_OUT'] ?? '/tmp/qa-device';
  Directory(out).createSync(recursive: true);
  await integrationDriver(
    onScreenshot: (name, bytes, [args]) async {
      File('$out/$name.png').writeAsBytesSync(bytes);
      return true;
    },
    responseDataCallback: (data) async {
      if (data == null) return;
      for (final e in data.entries) {
        if (e.value is Map<String, dynamic> && (e.value as Map).containsKey('traceEvents')) {
          final t = Timeline.fromJson(e.value as Map<String, dynamic>);
          await TimelineSummary.summarize(t).writeTimelineToFile(e.key, destinationDirectory: out, pretty: true, includeSummary: true);
        } else {
          File('$out/${e.key}.json').writeAsStringSync('${e.value}');
        }
      }
    },
  );
}
