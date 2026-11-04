import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Device choices win over server defaults. The server sets the initial owner language,
/// so Ran's Hebrew installation and a new English installation use the same build.
class AppPreferences extends ChangeNotifier {
  SharedPreferences? _prefs;
  String language = 'en';
  bool advanced = false;
  bool newInterface = true;
  ThemeMode themeMode = ThemeMode.system;
  bool _languageChosen = false, _advancedChosen = false;

  Future<void> load(SharedPreferences? prefs) async {
    _prefs = prefs;
    _languageChosen = prefs?.containsKey('language') ?? false;
    _advancedChosen = prefs?.containsKey('advanced_mode') ?? false;
    language = prefs?.getString('language') == 'he' ? 'he' : 'en';
    advanced = prefs?.getBool('advanced_mode') ?? false;
    newInterface = prefs?.getBool('new_interface') ?? true;
    themeMode = ThemeMode.values.asNameMap()[prefs?.getString('appearance')] ?? ThemeMode.system;
    notifyListeners();
  }

  void defaults(String language, bool advanced) {
    final l = language == 'he' ? 'he' : 'en';
    if ((!_languageChosen && this.language != l) || (!_advancedChosen && this.advanced != advanced)) {
      if (!_languageChosen) this.language = l;
      if (!_advancedChosen) this.advanced = advanced;
      notifyListeners();
    }
  }

  Future<void> setLanguage(String value) async {
    _languageChosen = true;
    language = value == 'he' ? 'he' : 'en';
    notifyListeners();
    await _prefs?.setString('language', language);
  }

  Future<void> setAdvanced(bool value) async {
    _advancedChosen = true;
    advanced = value;
    notifyListeners();
    await _prefs?.setBool('advanced_mode', value);
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
