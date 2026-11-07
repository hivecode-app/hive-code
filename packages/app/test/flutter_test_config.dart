import 'dart:async';

import 'package:agent_company/data/store.dart';

/// Every test: no read of the task stages left waiting for the end of the minute when the test ends.
Future<void> testExecutable(FutureOr<void> Function() testMain) async {
  AppStore.readPipelineLater = false;
  await testMain();
}
