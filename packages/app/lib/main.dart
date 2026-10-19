import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';

import 'data/backend.dart';
import 'data/backend_select.dart';
import 'data/store.dart';
import 'theme/theme.dart';
import 'theme/tokens.dart';
import 'ui/nav.dart';
import 'ui/shell.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final store = AppStore(await selectBackend());
  store.start();
  runApp(CompanyApp(store: store));
}

class CompanyApp extends StatefulWidget {
  const CompanyApp({super.key, required this.store, this.themeMode = ThemeMode.system, this.home});
  final AppStore store;

  /// Dark mode follows the device (owner decision, 20/10/2026). Tests pin it.
  final ThemeMode themeMode;
  final Widget? home;

  Backend get backend => store.backend;

  @override
  State<CompanyApp> createState() => _CompanyAppState();
}

class _CompanyAppState extends State<CompanyApp> {
  final nav = AppNav();

  @override
  Widget build(BuildContext context) {
    return StoreScope(
      store: widget.store,
      child: NavScope(
        nav: nav,
        child: MaterialApp(
          title: 'החברה',
          debugShowCheckedModeBanner: false,
          theme: buildTheme(Palette.light),
          darkTheme: buildTheme(Palette.darkPalette),
          themeMode: widget.themeMode,
          locale: const Locale('he'),
          supportedLocales: const [Locale('he')],
          localizationsDelegates: const [
            GlobalMaterialLocalizations.delegate,
            GlobalWidgetsLocalizations.delegate,
            GlobalCupertinoLocalizations.delegate,
          ],
          builder: (context, child) {
            // Android font size is honoured up to 130% (APP-SPEC §7.3).
            final mq = MediaQuery.of(context);
            final scale = mq.textScaler.clamp(maxScaleFactor: 1.3);
            return MediaQuery(data: mq.copyWith(textScaler: scale), child: child!);
          },
          home: widget.home ?? const Shell(),
        ),
      ),
    );
  }
}
