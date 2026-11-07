import 'dart:ui' show PlatformDispatcher;

import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// The language before there is a session (the sign-in screen, the first frame): his own choice, else the
/// server's from the last time this device was signed in, else the device's. So Ran's phone signs in in
/// Hebrew after a sign-out too, and a new English installation still starts in English.
String startLanguage(SharedPreferences? prefs, {String? device}) {
  final v = prefs?.getString('language') ?? prefs?.getString('language_server') ?? device ?? PlatformDispatcher.instance.locale.languageCode;
  return v == 'he' ? 'he' : 'en';
}

/// Device choices win over server defaults. The server sets the initial owner language,
/// so Ran's Hebrew installation and a new English installation use the same build.
class AppPreferences extends ChangeNotifier {
  SharedPreferences? _prefs;
  String language = 'en';
  bool newInterface = true;
  ThemeMode themeMode = ThemeMode.system;
  bool _languageChosen = false;

  Future<void> load(SharedPreferences? prefs) async {
    _prefs = prefs;
    _languageChosen = prefs?.containsKey('language') ?? false;
    language = startLanguage(prefs);
    newInterface = prefs?.getBool('new_interface') ?? true;
    themeMode = ThemeMode.values.asNameMap()[prefs?.getString('appearance')] ?? ThemeMode.system;
    notifyListeners();
  }

  /// The server's language, unless he chose one here. Kept, so the next sign-in screen speaks it.
  void defaults(String language) {
    final l = language == 'he' ? 'he' : 'en';
    if (_prefs?.getString('language_server') != l) _prefs?.setString('language_server', l);
    if (!_languageChosen && this.language != l) {
      this.language = l;
      notifyListeners();
    }
  }

  Future<void> setLanguage(String value) async {
    _languageChosen = true;
    language = value == 'he' ? 'he' : 'en';
    notifyListeners();
    await _prefs?.setString('language', language);
  }

  Future<void> setNewInterface(bool value) async {
    newInterface = value;
    notifyListeners();
    await _prefs?.setBool('new_interface', value);
  }

  Future<void> setAppearance(ThemeMode value) async {
    themeMode = value;
    notifyListeners();
    await _prefs?.setString('appearance', value.name);
  }
}
