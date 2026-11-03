import 'dictation_files.dart';

/// The web keeps a failed recording for as long as the tab is open.
DictationFiles deviceFiles() => MemoryDictationFiles();
