// Test harness: real fonts (Heebo, JetBrains Mono, Material Symbols Rounded) so goldens show
// what the phone shows, frozen motion, the demo backend at 14:06 on 20/10/2026.
import 'package:agent_company/data/fake_backend.dart';
import 'package:agent_company/data/store.dart';
import 'package:agent_company/main.dart';
import 'package:agent_company/ui/common.dart';
import 'package:agent_company/ui/convs/conversations_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

bool _fontsLoaded = false;

Future<void> loadFonts() async {
  if (_fontsLoaded) return;
  _fontsLoaded = true;
  Future<void> family(String name, List<String> assets) async {
    final l = FontLoader(name);
    for (final a in assets) {
      l.addFont(rootBundle.load(a));
    }
    await l.load();
  }

  await family('Heebo', ['assets/fonts/Heebo-400.ttf', 'assets/fonts/Heebo-500.ttf', 'assets/fonts/Heebo-700.ttf']);
  await family('JetBrainsMono', ['assets/fonts/JetBrainsMono-400.ttf', 'assets/fonts/JetBrainsMono-700.ttf']);
  await family('packages/material_symbols_icons/MaterialSymbolsRounded', ['packages/material_symbols_icons/lib/fonts/MaterialSymbolsRounded.ttf']);
}

/// The demo's "now": 14:06 on 20/10/2026, the day the fake data lives on.
final kDemoNow = DateTime(2026, 10, 20, 14, 6);

/// Pins the app's one clock ([CompanyTime.clock]) to [at] for this test, so "היום", "אתמול" and "לפני 5 דק'"
/// read the same on any day the tests run (#125).
void pinClock(DateTime at) {
  CompanyTime.clock = () => at;
  addTearDown(() => CompanyTime.clock = DateTime.now);
}

/// Text as the reader sees it: bidi controls (LRI/PDI, word joiners) are invisible, so the
/// finder ignores them (lib/ui/bidi.dart adds them around English runs in Hebrew text).
Finder findShown(String text) => find.byWidgetPredicate((w) => w is RichText && stripBidi(w.text.toPlainText()).contains(text));

/// Phone screen of the mockup: 342 x 716 logical px (360 frame minus bezel, status and gesture bars).
const kPhone = Size(342, 716);

Future<AppStore> pumpApp(WidgetTester tester, {Widget? home, bool dark = false, Size size = kPhone, double textScale = 1}) async {
  await loadFonts();
  Motion.frozen = true;
  pinClock(kDemoNow);
  SharedPreferences.setMockInitialValues({});
  tester.view.physicalSize = size * 2;
  tester.view.devicePixelRatio = 2;
  tester.platformDispatcher.textScaleFactorTestValue = textScale;
  addTearDown(tester.view.reset);
  addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
  final store = AppStore(FakeBackend(simulate: false, now: kDemoNow));
  await store.start();
  await tester.pumpWidget(CompanyApp(store: store, themeMode: dark ? ThemeMode.dark : ThemeMode.light, home: home));
  await tester.pump();
  return store;
}

/// The home alone (HomeV2, unfolded): the phone has it as the list's first item (convs_v2.dart) and the desktop
/// in the main column (desktop.dart); these tests cover the widget itself.
Widget homeAlone() => const _HomeAlone();

class _HomeAlone extends StatelessWidget {
  const _HomeAlone();
  @override
  Widget build(BuildContext context) {
    final d = StoreScope.of(context).data;
    if (d == null) return const SizedBox.shrink();
    return Scaffold(body: ListView(padding: EdgeInsets.zero, children: [HomeV2(recipe: d.home, data: d, now: CompanyTime.now())]));
  }
}
