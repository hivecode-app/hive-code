import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import '../../data/auth_client.dart';
import '../../data/backend_select.dart';
import '../../data/store.dart';
import '../../l10n/app_localizations.dart';
import '../../model/models.dart';
import '../../native/native_bridge.dart';
import '../../native/native_glue.dart';
import '../../theme/tokens.dart';
import '../common.dart';
import 'product_theme.dart';
import '../convs/home_v2.dart';
import '../company_map/map_screen.dart';
import '../resources/resources_screen.dart';
import '../settings/devices_screen.dart';
import '../settings/settings_screen.dart' show AccountSwitch, AutomationsScreen, kVersion;
import '../status/status_screen.dart';

class ProductSettings extends StatefulWidget {
  const ProductSettings({super.key, this.embedded = false});
  final bool embedded;
  @override
  State<ProductSettings> createState() => _ProductSettingsState();
}

class _ProductSettingsState extends State<ProductSettings> {
  bool busy = false;
  Future<void> leave() async {
    setState(() => busy = true);
    final store = StoreScope.read(context);
    try {
      final s = await savedSession();
      if (s != null) {
        final c = AuthClient(s.baseUrl);
        try {
          final me = (await c.devices(s.token)).devices.where((d) => d.current).firstOrNull;
          if (me != null) await c.revokeDevice(s.token, me.id);
        } on AuthFailure {
          /* Already offline: the saved session still leaves this device. */
        } finally {
          c.close();
        }
      }
      await clearSession();
      await kGlue?.syncConfig();
      if (mounted) kSignOut?.call(AppLocalizations.of(context).signOut);
    } catch (_) {
      if (mounted) store.notice(AppLocalizations.of(context).signOutFailed);
      store.touch();
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(listenable: StoreScope.of(context).preferences, builder: (context, _) => _build(context));

  Widget _build(BuildContext context) {
    final store = StoreScope.of(context), l = AppLocalizations.of(context), p = context.p;
    final prefs = store.preferences;
    final owner = store.data?.ownerName.isNotEmpty == true ? store.data!.ownerName : (companyNames.placeholder ? '' : companyNames.owner);
    void page(Widget page) => Navigator.push(context, MaterialPageRoute<void>(builder: (_) => page));
    Widget row(String icon, String label, {String? subtitle, Widget? trailing, VoidCallback? onTap}) => ListTile(
      leading: Ic(icon, size: 22, color: p.text2),
      title: Text(label, style: T.row2.copyWith(color: p.text)),
      subtitle: subtitle == null ? null : ProductContentText(subtitle, style: T.small.copyWith(color: p.text2)),
      trailing: trailing ?? (onTap == null ? null : Ic(chevronIcon(context), size: 20, color: p.text3)),
      onTap: onTap,
    );
    Future<void> choose<V>(String title, V current, List<(V, String)> values, ValueChanged<V> onPick) => showModalBottomSheet<void>(
      context: context,
      useSafeArea: true,
      builder: (context) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Padding(
              padding: const EdgeInsets.all(20),
              child: Text(title, style: T.name.copyWith(color: p.text)),
            ),
            for (final (value, label) in values)
              ListTile(
                title: Text(label),
                trailing: value == current ? const Ic('check') : null,
                onTap: () {
                  Navigator.pop(context);
                  onPick(value);
                },
              ),
          ],
        ),
      ),
    );
    Widget choiceRow(String icon, String label, String value, VoidCallback onTap, {Key? key}) => ListTile(
      key: key,
      leading: Ic(icon, size: 22, color: p.text2),
      title: Text(label, style: T.row2.copyWith(color: p.text)),
      subtitle: MediaQuery.textScalerOf(context).scale(1) > 1.3 ? Text(value, style: T.small.copyWith(color: p.text2)) : null,
      trailing: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (MediaQuery.textScalerOf(context).scale(1) <= 1.3) Text(value, style: T.row2.copyWith(color: p.text2)),
          const SizedBox(width: 8),
          Ic(chevronIcon(context), size: 20, color: p.text3),
        ],
      ),
      onTap: onTap,
    );
    final body = Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 14),
          child: Row(
            children: [
              if (!widget.embedded) IBtn(backIcon(context), tip: l.back, onTap: () => Navigator.pop(context)),
              Expanded(
                child: Text(l.settings, style: T.bar.copyWith(color: p.text)),
              ),
            ],
          ),
        ),
        Expanded(
          child: ListView(
            children: [
              row('account_circle', owner.isEmpty ? l.account : owner, subtitle: owner.isEmpty ? null : l.account),
              AccountSwitch(backend: store.backend),
              Section(l.work),
              row('dns', l.server, subtitle: store.backend.label, onTap: !kIsWeb ? () => kSwitchServer?.call() : null),
              row(
                'shield',
                l.access,
                onTap: () => showDialog<void>(
                  context: context,
                  builder: (_) => AlertDialog(
                    title: Text(l.access),
                    content: SingleChildScrollView(child: Text('${l.accessDetail}\n\n${l.responsibility}')),
                    actions: [TextButton(onPressed: () => Navigator.pop(context), child: Text(l.acknowledge))],
                  ),
                ),
              ),
              Section(l.thisDevice),
              row('devices', l.devices, onTap: () => page(const DevicesScreen())),
              row(
                'notifications',
                l.notifications,
                onTap: () => showModalBottomSheet<void>(
                  context: context,
                  useSafeArea: true,
                  builder: (context) => SafeArea(
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Section(l.notifications),
                        SwitchListTile(
                          title: Text(l.focus),
                          subtitle: Text(l.focusHint),
                          value: StoreScope.of(context).data?.focus ?? false,
                          onChanged: (_) => store.toggleFocus(),
                        ),
                        if (NativeBridge.instance.supported)
                          ListTile(
                            leading: const Ic('notifications_active'),
                            title: Text(l.thisDevice),
                            onTap: () => NativeBridge.instance.openNotificationSettings(),
                          ),
                      ],
                    ),
                  ),
                ),
              ),
              choiceRow(
                'translate',
                l.language,
                prefs.language == 'he' ? l.hebrewLanguage : l.englishLanguage,
                () => choose<String>(l.language, prefs.language, [('en', l.englishLanguage), ('he', l.hebrewLanguage)], prefs.setLanguage),
                key: const Key('language-choice'),
              ),
              choiceRow(
                'contrast',
                l.appearance,
                switch (prefs.themeMode) {
                  ThemeMode.system => l.deviceSetting,
                  ThemeMode.light => l.light,
                  ThemeMode.dark => l.dark,
                },
                () => choose<ThemeMode>(l.appearance, prefs.themeMode, [
                  (ThemeMode.system, l.deviceSetting),
                  (ThemeMode.light, l.light),
                  (ThemeMode.dark, l.dark),
                ], prefs.setAppearance),
              ),
              SwitchListTile(
                key: const Key('new-interface'),
                title: Text(l.newInterface),
                subtitle: Text(l.newInterfaceHint),
                value: prefs.newInterface,
                onChanged: (v) {
                  prefs.setNewInterface(v);
                  if (!widget.embedded && Navigator.canPop(context)) Navigator.pop(context);
                },
              ),
              SwitchListTile(
                key: const Key('advanced-mode'),
                title: Text(l.advancedMode),
                subtitle: Text(l.advancedHint),
                value: prefs.advanced,
                onChanged: prefs.setAdvanced,
              ),
              if (prefs.advanced) ...[
                row('home', l.companyOverview, onTap: () => page(Scaffold(appBar: AppBar(leading: IBtn(backIcon(context), tip: l.back, onTap: () => Navigator.pop(context)), title: Text(l.companyOverview)), body: const HomeV2Page()))),
                row('hub', l.companyMap, onTap: () => page(const CompanyMapPage())),
                row('memory', l.resources, onTap: () => page(const ResourcesPage())),
                row('tune', l.automations, onTap: () => page(const AutomationsScreen())),
                row(
                  'monitor_heart',
                  l.status,
                  onTap: () => page(const Scaffold(body: SafeArea(child: StatusScreen()))),
                ),
              ],
              row('logout', l.signOut, onTap: busy ? null : leave),
              row('info', l.version, subtitle: kVersion),
              const SizedBox(height: 24),
            ],
          ),
        ),
      ],
    );
    return widget.embedded
        ? body
        : Scaffold(
            backgroundColor: p.bg,
            body: SafeArea(child: body),
          );
  }
}
