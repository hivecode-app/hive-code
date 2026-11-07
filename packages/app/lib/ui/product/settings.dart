// Settings as in direction A (docs/product/design-v2, a-he-settings-*): the account, then work (the Claude
// subscription with its week, the server, access), then this device (notifications, language, appearance).
// On a phone each row opens its page; on a wide screen the list stays as a menu and the page opens beside it.
// The account switch lives in the subscription's page, not on top of the list.
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:intl/intl.dart' show DateFormat;

import '../../data/auth_client.dart';
import '../../data/backend_select.dart';
import '../../data/store.dart';
import '../../l10n/app_localizations.dart';
import '../../model/home_recipe.dart';
import '../../model/models.dart';
import '../../native/native_glue.dart';
import '../../theme/tokens.dart';
import '../common.dart';
import '../company_map/map_screen.dart';
import '../convs/home_quota.dart';
import '../convs/home_v2.dart';
import '../resources/resources_screen.dart';
import '../settings/devices_screen.dart';
import '../settings/settings_screen.dart' show AccountSwitch, AutomationsScreen, kVersion;
import '../status/status_screen.dart';
import 'notifications_settings.dart';
import 'work_settings.dart';

enum SettingsPage { account, claude, server, access, notifications, language, appearance, tools }

/// "נוצל 38% השבוע · מתאפס ביום שישי": the Claude accounts' week as one (hq averages them the same way), and the
/// nearest weekly reset. Null when hq has not read any account yet.
String? claudeWeek(AppLocalizations l, List<QuotaLine> quota, DateTime now) {
  final claude = [for (final q in quota) if (q.usable && !q.isCodex && q.sevenDay != null) q];
  if (claude.isEmpty) return null;
  // A week that already reset counts as unused until the next measurement, not as last week's percent.
  bool past(QuotaLine q) => q.sevenDayResets != null && !q.sevenDayResets!.isAfter(now);
  final pct = (claude.map((q) => past(q) ? 0 : q.sevenDay!).reduce((a, b) => a + b) / claude.length).round();
  final resets = [for (final q in claude) if (q.sevenDayResets case final t? when t.isAfter(now)) t]..sort();
  // His day, on the company clock, as the quota card below it.
  final day = resets.isEmpty ? null : daysAgo(now, resets.first) == 0 ? l.claudeResetsToday : l.claudeResets(DateFormat.EEEE(l.localeName).format(wall(resets.first)));
  return [l.claudeUsage('$kLRI$pct%$kPDI'), ?day].join(' · ');
}

class ProductSettings extends StatefulWidget {
  const ProductSettings({super.key});
  @override
  State<ProductSettings> createState() => _ProductSettingsState();
}

class _ProductSettingsState extends State<ProductSettings> {
  SettingsPage open = SettingsPage.account;

  @override
  Widget build(BuildContext context) => ListenableBuilder(listenable: StoreScope.of(context).preferences, builder: (context, _) => _build(context));

  Widget _build(BuildContext context) {
    final store = StoreScope.of(context), l = AppLocalizations.of(context), p = context.p;
    final prefs = store.preferences, d = store.data;
    final owner = d?.ownerName.isNotEmpty == true ? d!.ownerName : (companyNames.placeholder ? '' : companyNames.owner);
    final language = prefs.language == 'he' ? l.hebrewLanguage : l.englishLanguage;
    final appearance = switch (prefs.themeMode) { ThemeMode.system => l.deviceSetting, ThemeMode.light => l.light, ThemeMode.dark => l.dark };
    final notifications = d == null
        ? null
        : !(d.automations.where((a) => a.key == 'push').firstOrNull?.enabled ?? true)
            ? l.notifSummaryOff
            : d.focus ? l.notifSummaryFocus : d.night != null ? l.notifSummaryNight : l.notifSummaryOn;

    return LayoutBuilder(builder: (context, box) {
      final wide = box.maxWidth >= 760;
      void go(SettingsPage page) {
        if (wide) return setState(() => open = page);
        switch (page) {
          case SettingsPage.language:
            _choose<String>(context, l.language, prefs.language, [('en', l.englishLanguage), ('he', l.hebrewLanguage)], prefs.setLanguage);
          case SettingsPage.appearance:
            _choose<ThemeMode>(context, l.appearance, prefs.themeMode, [(ThemeMode.system, l.deviceSetting), (ThemeMode.light, l.light), (ThemeMode.dark, l.dark)], prefs.setAppearance);
          default:
            Navigator.push(context, MaterialPageRoute<void>(builder: (_) => SettingsPageView(page: page)));
        }
      }

      Widget item(SettingsPage page, String icon, String title, {String? sub, String? value, Key? key}) => wide
          ? _MenuRow(key: key, icon: icon, title: page == SettingsPage.account ? l.account : title, selected: open == page, onTap: () => go(page))
          : _Row(key: key, icon: icon, title: title, sub: sub, value: value, onTap: () => go(page));

      final items = [
        item(SettingsPage.account, 'account_circle', owner.isEmpty ? l.account : owner, sub: l.settingsAccountSub),
        if (!wide) Section(l.work, top: 24),
        item(SettingsPage.claude, 'key', l.claudeSubscription, sub: claudeWeek(l, d?.home?.quota ?? const [], CompanyTime.now())),
        item(SettingsPage.server, 'dns', l.server, value: store.backend.label),
        item(SettingsPage.access, 'shield', l.access, value: l.accessFull),
        if (!wide) Section(l.thisDevice, top: 24),
        item(SettingsPage.notifications, 'notifications', l.notifications, sub: notifications, key: const Key('notifications-settings')),
        item(SettingsPage.language, 'translate', l.language, value: language, key: const Key('language-choice')),
        item(SettingsPage.appearance, 'contrast', l.appearance, value: appearance),
        if (!wide) const SizedBox(height: 24),
        item(SettingsPage.tools, 'build', l.tools, sub: l.toolsHint, key: const Key('settings-tools')),
      ];

      final title = Padding(
        padding: EdgeInsets.fromLTRB(wide ? 24 : 20, 0, wide ? 24 : 20, 16),
        child: Text(l.settings, style: (wide ? T.bar : T.big).copyWith(color: p.text)),
      );
      final back = Padding(padding: const EdgeInsets.fromLTRB(8, 4, 8, 4), child: Align(alignment: AlignmentDirectional.centerStart, child: IBtn(backIcon(context), tip: l.back, onTap: () => Navigator.pop(context))));

      final Widget body;
      if (wide) {
        body = Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          SizedBox(
            width: 260,
            child: Container(
              decoration: BoxDecoration(color: p.bg, border: BorderDirectional(end: BorderSide(color: p.line))),
              child: ListView(padding: const EdgeInsets.only(bottom: 24), children: [back, title, for (final w in items) Padding(padding: const EdgeInsets.symmetric(horizontal: 12), child: w)]),
            ),
          ),
          Expanded(child: ColoredBox(color: p.surface, child: SettingsPageView(key: ValueKey(open), page: open, inline: true))),
        ]);
      } else {
        // Rows of one group share a white block, as in the mockup; the section headers sit on the background.
        final groups = <List<Widget>>[[]];
        for (final w in items) {
          if (w is Section || w is SizedBox) {
            groups.add([w]);
            groups.add([]);
          } else {
            groups.last.add(w);
          }
        }
        body = ListView(children: [
          back,
          title,
          for (final g in groups)
            if (g.length == 1 && (g.first is Section || g.first is SizedBox)) g.first else if (g.isNotEmpty) ListBlock(inset: 56, children: g),
          const SizedBox(height: 24),
        ]);
      }
      return Scaffold(backgroundColor: p.bg, body: SafeArea(child: body));
    });
  }
}

Future<void> _choose<V>(BuildContext context, String title, V current, List<(V, String)> values, ValueChanged<V> onPick) => showModalBottomSheet<void>(
      context: context,
      useSafeArea: true,
      builder: (context) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Padding(padding: const EdgeInsets.all(20), child: Text(title, style: T.name.copyWith(color: context.p.text))),
          for (final (value, label) in values)
            ListTile(
              title: Text(label),
              trailing: value == current ? const Ic('check') : null,
              onTap: () {
                Navigator.pop(context);
                onPick(value);
              },
            ),
        ]),
      ),
    );

/// A row of the phone's list: icon, title and an optional second line, or a value before the chevron.
class _Row extends StatelessWidget {
  const _Row({super.key, required this.icon, required this.title, this.sub, this.value, this.onTap});
  final String icon, title;
  final String? sub, value;
  final VoidCallback? onTap;
  @override
  Widget build(BuildContext context) {
    final p = context.p;
    final big = MediaQuery.textScalerOf(context).scale(1) > 1.3;
    final second = sub ?? (big ? value : null);
    return InkWell(
      onTap: onTap,
      child: ConstrainedBox(
        constraints: BoxConstraints(minHeight: second == null ? 56 : 68),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
          child: Row(children: [
            Ic(icon, size: 24, color: p.text2),
            const SizedBox(width: 16),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                Text(title, style: T.body.copyWith(color: p.text)),
                if (second != null) Text(second, style: T.small.copyWith(color: p.text2)),
              ]),
            ),
            if (value != null && !big) ...[const SizedBox(width: 12), Text(value!, style: T.row2.copyWith(color: p.text2))],
            if (onTap != null) ...[const SizedBox(width: 8), Ic(chevronIcon(context), size: 20, color: p.text3)],
          ]),
        ),
      ),
    );
  }
}

/// A row of the wide screen's inner menu: the selected page on a soft background.
class _MenuRow extends StatelessWidget {
  const _MenuRow({super.key, required this.icon, required this.title, required this.selected, required this.onTap});
  final String icon, title;
  final bool selected;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) {
    final p = context.p;
    return Semantics(
      selected: selected,
      button: true,
      child: Material(
        color: selected ? p.surface3 : Colors.transparent,
        borderRadius: BorderRadius.circular(8),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onTap,
          child: SizedBox(
            height: 44,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12),
              child: Row(children: [
                Ic(icon, size: 22, color: selected ? p.text : p.text2),
                const SizedBox(width: 14),
                Expanded(child: Text(title, maxLines: 1, overflow: TextOverflow.ellipsis, style: T.row2.copyWith(color: p.text, fontWeight: selected ? FontWeight.w700 : FontWeight.w400))),
              ]),
            ),
          ),
        ),
      ),
    );
  }
}

/// One settings page: pushed on a phone (with a back arrow), or beside the menu on a wide screen ([inline]).
class SettingsPageView extends StatelessWidget {
  const SettingsPageView({super.key, required this.page, this.inline = false});
  final SettingsPage page;
  final bool inline;

  @override
  Widget build(BuildContext context) => ListenableBuilder(listenable: StoreScope.of(context).preferences, builder: (context, _) => _build(context));

  Widget _build(BuildContext context) {
    final store = StoreScope.of(context), l = AppLocalizations.of(context), p = context.p;
    final prefs = store.preferences, d = store.data;
    void push(Widget w) => Navigator.push(context, MaterialPageRoute<void>(builder: (_) => w));
    Widget text(String s) => Padding(padding: const EdgeInsets.fromLTRB(16, 0, 16, 14), child: Text(s, style: T.body.copyWith(color: p.text)));
    Widget pick<V>(V current, List<(V, String)> values, ValueChanged<V> onPick) => ListBlock(inset: 16, children: [
          for (final (value, label) in values)
            InkWell(
              onTap: () => onPick(value),
              child: SizedBox(
                height: 52,
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 16),
                  child: Row(children: [Expanded(child: Text(label, style: T.body.copyWith(color: p.text))), if (value == current) Ic('check', color: p.text)]),
                ),
              ),
            ),
        ]);

    final (String title, String? sub, List<Widget> children) = switch (page) {
      SettingsPage.account => (
          d?.ownerName.isNotEmpty == true ? d!.ownerName : l.account,
          null,
          [
            ListBlock(inset: 56, children: [
              _Row(icon: 'devices', title: l.devices, onTap: () => push(const DevicesScreen())),
              const _SignOutRow(),
              _Row(icon: 'info', title: l.version, sub: kVersion),
            ]),
          ],
        ),
      SettingsPage.claude => (
          l.claudeSubscription,
          claudeWeek(l, d?.home?.quota ?? const [], CompanyTime.now()),
          [
            if (d?.home?.quota case final q? when q.isNotEmpty) ...[Section(l.claudeAccounts), ListBlock(inset: 16, children: [QuotaCard(quota: q, now: CompanyTime.now())])],
            AccountSwitch(backend: store.backend),
            const SizedBox(height: 16),
            ListBlock(inset: 56, children: [_Row(icon: 'tune', title: l.workSettingsTitle, onTap: () => push(const WorkSettingsScreen()))]),
          ],
        ),
      SettingsPage.server => (
          l.server,
          null,
          [
            ListBlock(inset: 16, children: [
              Padding(
                padding: const EdgeInsets.all(16),
                child: Text(store.backend.label, textDirection: TextDirection.ltr, textAlign: TextAlign.start, style: T.mono(15).copyWith(color: p.text)),
              ),
              if (!kIsWeb && kSwitchServer != null) _Row(icon: 'dns', title: l.switchServer, onTap: () => kSwitchServer?.call()),
            ]),
          ],
        ),
      SettingsPage.access => (l.access, null, [text(l.approvedCopy15), text(l.approvedCopy18), text(l.setupTermsBody)]),
      SettingsPage.notifications => (l.notifications, l.notifTitleSub, const [NotificationsSettings()]),
      SettingsPage.language => (l.language, null, [pick<String>(prefs.language, [('he', l.hebrewLanguage), ('en', l.englishLanguage)], prefs.setLanguage)]),
      SettingsPage.appearance => (
          l.appearance,
          null,
          [pick<ThemeMode>(prefs.themeMode, [(ThemeMode.system, l.deviceSetting), (ThemeMode.light, l.light), (ThemeMode.dark, l.dark)], prefs.setAppearance)],
        ),
      SettingsPage.tools => (
          l.tools,
          null,
          [
            ListBlock(inset: 56, children: [
              _Row(icon: 'home', title: l.companyOverview, onTap: () => push(Scaffold(appBar: AppBar(leading: IBtn(backIcon(context), tip: l.back, onTap: () => Navigator.pop(context)), title: Text(l.companyOverview)), body: const HomeV2Page()))),
              _Row(icon: 'hub', title: l.companyMap, onTap: () => push(const CompanyMapPage())),
              _Row(icon: 'memory', title: l.resources, onTap: () => push(const ResourcesPage())),
              _Row(icon: 'tune', title: l.automations, onTap: () => push(const AutomationsScreen())),
              _Row(icon: 'monitor_heart', title: l.status, onTap: () => push(const Scaffold(body: SafeArea(child: StatusScreen())))),
            ]),
          ],
        ),
    };

    final list = ListView(padding: EdgeInsets.only(top: inline ? 32 : 0, bottom: 32), children: [
      if (!inline) Padding(padding: const EdgeInsets.fromLTRB(8, 4, 8, 4), child: Align(alignment: AlignmentDirectional.centerStart, child: IBtn(backIcon(context), tip: l.back, onTap: () => Navigator.pop(context)))),
      Padding(
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 20),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(title, style: (inline ? T.bar : T.big).copyWith(color: p.text)),
          if (sub != null) Padding(padding: const EdgeInsets.only(top: 4), child: Text(sub, style: T.secondary.copyWith(color: p.text2))),
        ]),
      ),
      ...children,
    ]);
    if (inline) return Align(alignment: AlignmentDirectional.topStart, child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 720), child: Padding(padding: const EdgeInsets.symmetric(horizontal: 24), child: list)));
    return Scaffold(backgroundColor: p.bg, body: SafeArea(child: list));
  }
}

/// "יציאה מהמכשיר הזה": revokes this device's token on hq when it can, then forgets the session.
class _SignOutRow extends StatefulWidget {
  const _SignOutRow();
  @override
  State<_SignOutRow> createState() => _SignOutRowState();
}

class _SignOutRowState extends State<_SignOutRow> {
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
  Widget build(BuildContext context) => _Row(icon: 'logout', title: AppLocalizations.of(context).signOut, onTap: busy ? null : leave);
}
