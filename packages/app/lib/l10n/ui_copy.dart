// The active catalogue for synchronous helpers outside a widget's build (models, the backend, errors).
// Widgets that build text use AppLocalizations; these helpers rebuild with [watch] on a language change.
import 'package:flutter/widgets.dart';
import 'app_localizations.dart';

class UiCopy {
  static AppLocalizations copy = lookupAppLocalizations(const Locale('he'));
  static void configure(String language) => copy = lookupAppLocalizations(Locale(language));
  static void watch(BuildContext context) {
    final locale = Localizations.maybeLocaleOf(context);
    if (locale != null && locale.languageCode != copy.localeName) {
      copy = lookupAppLocalizations(Locale(locale.languageCode == 'he' ? 'he' : 'en'));
    }
  }
}
