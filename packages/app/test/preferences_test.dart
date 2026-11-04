import 'package:agent_company/data/app_preferences.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  test('English and basic mode by default; Ran settings come from server fields', () async {
    SharedPreferences.setMockInitialValues({});
    final prefs = AppPreferences();
    await prefs.load(await SharedPreferences.getInstance());
    expect(prefs.language, 'en');
    expect(prefs.advanced, isFalse);
    expect(prefs.newInterface, isTrue);
    prefs.defaults('he', true);
    expect(prefs.language, 'he');
    expect(prefs.advanced, isTrue);
    await prefs.setLanguage('en');
    await prefs.setAdvanced(false);
    prefs.defaults('he', true);
    expect(prefs.language, 'en');
    expect(prefs.advanced, isFalse);
  });
  test('device choices survive restarting and server defaults cannot override them', () async {
    SharedPreferences.setMockInitialValues({});
    final disk = await SharedPreferences.getInstance();
    final prefs = AppPreferences();
    await prefs.load(disk);
    await prefs.setLanguage('he');
    await prefs.setAdvanced(true);
    await prefs.setNewInterface(false);
    await prefs.setAppearance(ThemeMode.dark);
    final reloaded = AppPreferences();
    await reloaded.load(disk);
    reloaded.defaults('en', false);
    expect(reloaded.language, 'he');
    expect(reloaded.advanced, isTrue);
    expect(reloaded.newInterface, isFalse);
    expect(reloaded.themeMode, ThemeMode.dark);
  });
}
