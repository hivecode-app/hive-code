import 'package:agent_company/data/app_preferences.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  test('English by default; the server language applies and is kept for the next sign-in screen', () async {
    SharedPreferences.setMockInitialValues({});
    final disk = await SharedPreferences.getInstance();
    final prefs = AppPreferences();
    await prefs.load(disk);
    expect(prefs.language, 'en');
    prefs.defaults('he');
    expect(prefs.language, 'he');
    // Signed out, before any data: the sign-in screen speaks the server's language, not English.
    expect(startLanguage(disk, device: 'en'), 'he');
    await prefs.setLanguage('en');
    prefs.defaults('he');
    expect(prefs.language, 'en');
    expect(startLanguage(disk, device: 'he'), 'en');
  });
  test('before any server: his choice, else the device language', () async {
    SharedPreferences.setMockInitialValues({});
    final disk = await SharedPreferences.getInstance();
    expect(startLanguage(disk, device: 'he'), 'he');
    expect(startLanguage(disk, device: 'fr'), 'en');
    expect(startLanguage(null, device: 'he'), 'he');
  });
  test('device choices survive restarting and server defaults cannot override them', () async {
    SharedPreferences.setMockInitialValues({});
    final disk = await SharedPreferences.getInstance();
    final prefs = AppPreferences();
    await prefs.load(disk);
    await prefs.setLanguage('he');
    await prefs.setAppearance(ThemeMode.dark);
    final reloaded = AppPreferences();
    await reloaded.load(disk);
    reloaded.defaults('en');
    expect(reloaded.language, 'he');
    expect(reloaded.themeMode, ThemeMode.dark);
  });
}
