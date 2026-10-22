// In-app backend with the mockup's content (docs/app/prototype/index.html), so every screen can be
// built, tested and shown before hq is live. Behaviour mirrors the mockup script: 3s undo is the
// UI's job; this class only applies the result, simulates delivery acks and Dana's streaming.
import 'dart:async';

import '../model/company_time.dart';
import '../model/map_day.dart';
import '../model/resources.dart';
import '../model/models.dart';
import 'backend.dart';
import 'demo_map.dart';

class FakeBackend extends Backend {
  FakeBackend({this.simulate = true, DateTime? now}) : _now = now; // ignore: prefer_initializing_formals

  /// Off in tests and goldens: no timers, no streaming.
  final bool simulate;
  final DateTime? _now;
  CompanyData? _data;
  final List<Timer> _timers = [];

  @override
  CompanyData? get data => _data;

  @override
  SystemStatus get status => const SystemStatus(LinkState.demo);

  @override
  String get label => 'הדגמה';

  @override
  Future<MapDay?> companyDay(String date) async => demoMapDay(date, upTo: date == _ymdOf(_today) ? (_today.hour * 60 + _today.minute) * 60000 : kDayMs);

  @override
  Future<ResourcesView?> resources() async => demoResources();

  @override
  Future<MapBody?> companyMessage(String id) async => demoMapBody(id);

  static String _ymdOf(DateTime d) => '${d.year}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

  DateTime get _today => _now ?? CompanyTime.now();
  DateTime at(int h, int m) => DateTime(_today.year, _today.month, _today.day, h, m);

  @override
  Future<void> start() async {
    _data = buildDemo(at);
    notifyListeners();
    if (simulate) _streamDana();
  }

  bool _disposed = false;

  @override
  void dispose() {
    _disposed = true;
    for (final t in _timers) {
      t.cancel();
    }
    super.dispose();
  }

  void _later(Duration d, void Function() f) => _timers.add(Timer(d, () {
        f();
        notifyListeners();
      }));

  // Dana keeps writing the list for Moshe (the streaming bubble in mockup screen 4).
  void _streamDana() {
    final chat = _data!.chats['dana']!;
    final msg = chat.items.whereType<TextMsg>().lastWhere((t) => t.streaming);
    const rest = [' ומספר הגרסה', ', ושולחת לו', ' רק אחרי שהפריסה', ' עוברת את הבדיקות.'];
    var i = 0;
    _timers.add(Timer.periodic(const Duration(milliseconds: 1400), (t) {
      if (!msg.streaming) return t.cancel();
      if (i < rest.length) {
        msg.text += rest[i++];
      } else {
        msg.streaming = false;
        chat.live = const LiveState(phase: LivePhase.tool, label: 'מכינה את רשימת השינויים', runningCommand: null);
        t.cancel();
      }
      notifyListeners();
    }));
  }

  WaitItem? _waitFor(String? askId) => _data!.waiting.where((w) => w.askId == askId && askId != null).firstOrNull;

  void _answered(String askId, String answer) {
    final d = _data!;
    for (final c in d.chats.values) {
      for (final it in c.items) {
        if (it is AskCard && it.askId == askId) {
          it.state = AskState.answered;
          it.answer = answer;
        }
      }
    }
    final w = _waitFor(askId);
    if (w != null) {
      w.state = WaitState.answered;
      final p = d.presence[w.from];
      if (p != null) d.presence[w.from] = p.copyWith(status: WorkerStatus.working, activity: 'ממשיך', clearActivity: false);
    }
  }

  @override
  Future<CommandResult> answerAsk(String askId, AskOption option, {String? from}) async {
    _answered(askId, option.label);
    notifyListeners();
    return const CommandResult.ok();
  }

  @override
  Future<CommandResult> freeAnswer(String askId, String text, {List<Attachment> attachments = const []}) async {
    _answered(askId, text);
    notifyListeners();
    return const CommandResult.ok();
  }

  @override
  Future<CommandResult> go(WaitItem item) async {
    item.state = WaitState.answered;
    if (item.askId != null) _answered(item.askId!, 'GO');
    notifyListeners();
    return const CommandResult.ok();
  }

  @override
  Future<CommandResult> notNow(WaitItem item) async {
    item.state = WaitState.notNow;
    notifyListeners();
    return const CommandResult.ok();
  }

  @override
  Future<CommandResult> resume(WaitItem item) async {
    item.state = WaitState.open;
    notifyListeners();
    return const CommandResult.ok();
  }

  @override
  Future<CommandResult> dismiss(WaitItem item) async {
    item.state = WaitState.answered;
    item.answerLine = 'נסגר';
    notifyListeners();
    return const CommandResult.ok();
  }

  @override
  Future<CommandResult> retry(WaitItem item) async {
    item.state = WaitState.answered;
    notifyListeners();
    return const CommandResult.ok();
  }

  @override
  Future<CommandResult> handoffDone(WaitItem item) async {
    item.state = WaitState.answered;
    for (final c in _data!.chats.values) {
      for (final it in c.items) {
        if (it is HandoffCard) it.done = true;
      }
    }
    notifyListeners();
    return const CommandResult.ok();
  }

  @override
  Future<CommandResult> send(String identityId, UserMsg msg) async {
    final chat = _data!.chats[identityId];
    if (chat == null) return const CommandResult.fail('השיחה לא נמצאה.');
    if (!chat.items.contains(msg)) chat.items.add(msg);
    final busy = chat.live.busy;
    if (busy && msg.priority != Priority.now) {
      msg.delivery = Delivery.queued;
    } else {
      msg.delivery = Delivery.delivered;
      if (msg.priority == Priority.now && busy) chat.live = const LiveState(phase: LivePhase.starting, label: 'נעצרה וקוראת');
      if (simulate) {
        _later(const Duration(milliseconds: 900), () {
          msg.delivery = Delivery.read;
          chat.live = const LiveState(phase: LivePhase.thinking, seconds: 1);
        });
        _later(const Duration(milliseconds: 2600), () {
          chat.items.add(TextMsg(id: 'r-${msg.id}', ts: CompanyTime.now(), text: 'קיבלתי. אני על זה.'));
          msg.delivery = Delivery.handled;
          chat.live = const LiveState();
        });
      }
    }
    notifyListeners();
    return const CommandResult.ok();
  }

  @override
  Future<CommandResult> retract(String identityId, String msgId) async {
    final chat = _data!.chats[identityId];
    final m = chat?.items.whereType<UserMsg>().where((m) => m.id == msgId).firstOrNull;
    if (m == null || (m.delivery != Delivery.queued && m.delivery != Delivery.pendingConnection)) {
      return const CommandResult.fail('ההודעה כבר נמסרה, ולכן אי אפשר למשוך אותה.');
    }
    chat!.items.remove(m);
    notifyListeners();
    return const CommandResult.ok();
  }

  /// Opening a conversation reads it, as on hq.
  @override
  void showConversation(String identityId) => _setConv(identityId, (c) => c.copyWith(unread: 0));

  @override
  Future<CommandResult> mute(String identityId, MuteFor duration) async {
    _setConv(identityId, (c) => c.copyWith(muted: duration != MuteFor.off));
    return const CommandResult.ok();
  }

  void _setConv(String identityId, ConversationSummary Function(ConversationSummary) f) {
    final convs = _data?.conversations;
    final i = convs?.indexWhere((c) => c.identityId == identityId) ?? -1;
    if (i < 0) return;
    convs![i] = f(convs[i]);
    // Called from a screen being built (ChatScreen.didChangeDependencies): redraw after this frame's build.
    scheduleMicrotask(() {
      if (!_disposed) notifyListeners();
    });
  }

  @override
  Future<CommandResult> stop(String identityId) async {
    final chat = _data!.chats[identityId];
    final now = CompanyTime.now();
    final hm = '${now.hour.toString().padLeft(2, '0')}:${now.minute.toString().padLeft(2, '0')}';
    if (chat != null) {
      for (final t in chat.items.whereType<TextMsg>()) {
        t.streaming = false;
      }
      chat.live = LiveState(phase: LivePhase.stopped, stoppedAt: hm);
    }
    final p = _data!.presence[identityId];
    if (p != null) _data!.presence[identityId] = p.copyWith(status: WorkerStatus.free, clearActivity: true);
    notifyListeners();
    return const CommandResult.ok();
  }

  @override
  Future<CommandResult> setAutomation(String key, bool enabled) async {
    final a = _data!.automations.firstWhere((a) => a.key == key);
    a.enabled = enabled;
    notifyListeners();
    return const CommandResult.ok();
  }

  @override
  Future<CommandResult> setFocus(bool on) async {
    _data!.focus = on;
    notifyListeners();
    return const CommandResult.ok();
  }

  @override
  Future<CommandResult> wake(String teamId) async => const CommandResult.ok();
}

// ───────────────────────────── demo content (mockup, 20/10/2026 14:06) ─────────────────────────────

CompanyData buildDemo(DateTime Function(int h, int m) at) {
  const teams = {
    'mgmt': Team(id: 'mgmt', name: 'הנהלה', symbol: 'explore', leadId: 'yoav', tone: 'slate'),
    'monitor': Team(id: 'monitor', name: 'ניטור', symbol: 'shield', leadId: 'rotem', tone: 'slate'),
    'personal': Team(id: 'personal', name: 'הצוות האישי', symbol: 'folder_shared', leadId: 'eli', tone: 'slate'),
    'improve': Team(id: 'improve', name: 'מחלקת השיפור', symbol: 'build', leadId: 'noga', tone: 'slate'),
    'lumo': Team(id: 'lumo', name: 'לומו', symbol: 'local_shipping', leadId: 'dana', permanent: false, tone: 'teal'),
    'tikibot': Team(id: 'tikibot', name: 'טיקיבוט', symbol: 'smart_toy', permanent: false, tone: 'clay'),
    'voice': Team(id: 'voice', name: 'הבוט הקולי', symbol: 'graphic_eq', permanent: false, tone: 'sky'),
  };
  const ids = {
    'yoav': Identity(id: 'yoav', name: 'יואב', title: 'מנהל החברה', teamId: 'mgmt'),
    'rotem': Identity(id: 'rotem', name: 'רותם', title: 'ראש צוות הניטור', short: 'ניטור', teamId: 'monitor', gender: Gender.f),
    'ido': Identity(id: 'ido', name: 'עידו', title: 'מפתח', teamId: 'lumo', temp: true, taskRef: 't3711'),
    'dana': Identity(id: 'dana', name: 'דנה', title: 'מנכ"לית לומו', teamId: 'lumo', gender: Gender.f),
    'noa': Identity(id: 'noa', name: 'נועה', title: 'מפתחת', teamId: 'lumo', gender: Gender.f, temp: true, taskRef: 't3720'),
    'itai': Identity(id: 'itai', name: 'איתי', title: 'בודק איכות · טיקיבוט', short: 'בודק איכות', teamId: 'tikibot', temp: true),
    'amit': Identity(id: 'amit', name: 'עמית', title: 'מומחה כספים', short: 'כספים', teamId: 'personal'),
    'noga': Identity(id: 'noga', name: 'נגה', title: 'ראש מחלקת השיפור', short: 'מחלקת השיפור', teamId: 'improve', gender: Gender.f),
    'eli': Identity(id: 'eli', name: 'אלי', title: 'ראש הצוות האישי', short: 'הצוות האישי', teamId: 'personal'),
    'tamar': Identity(id: 'tamar', name: 'תמר', title: 'מומחית הפריסות של לומו', teamId: 'lumo', gender: Gender.f),
    'shira': Identity(id: 'shira', name: 'שירה', title: 'בודקת', teamId: 'lumo', gender: Gender.f, temp: true, taskRef: 't3698'),
    'gil': Identity(id: 'gil', name: 'גיל', title: 'מפתח', teamId: 'tikibot'),
    'maya': Identity(id: 'maya', name: 'מאיה', title: 'מפתחת', teamId: 'voice', gender: Gender.f),
  };
  final presence = <String, Presence>{
    'yoav': const Presence(status: WorkerStatus.free),
    'rotem': const Presence(status: WorkerStatus.waiting),
    'ido': const Presence(status: WorkerStatus.waiting, shift: 2, shiftSince: '12:40', contextPct: 62, machine: 'hq-host'),
    'dana': const Presence(status: WorkerStatus.working, activity: 'כותבת', shift: 7, machine: 'hq-host'),
    'noa': const Presence(status: WorkerStatus.working, shift: 1, machine: 'hq-host'),
    'itai': const Presence(status: WorkerStatus.stuck),
    'amit': const Presence(status: WorkerStatus.waiting),
    'noga': const Presence(status: WorkerStatus.working),
    'eli': const Presence(status: WorkerStatus.resting),
    'tamar': const Presence(status: WorkerStatus.resting),
  };

  const idoOptions = [
    AskOption(id: 'retry24', label: 'ניסיון נוסף אחרי 24 שעות', shortLabel: "ניסיון נוסף אחרי 24 ש'"),
    AskOption(id: 'cancel', label: 'ביטול המנוי מיד'),
  ];

  final waiting = [
    WaitItem(
      id: 'w-rotem',
      kind: WaitKind.urgentProd,
      from: 'rotem',
      time: "לפני 6 דק'",
      kicker: 'דחוף בפרודקשן · טיקיבוט',
      body: 'ה-webhook של וואטסאפ מחזיר 502 מ-13:58, כנראה מהפריסה של 13:55. ההצעה: לחזור ל-`r207`.',
      options: const [AskOption(id: 'go', label: 'GO לחזרה', primary: true)],
      askId: 'ask-rotem',
      doneLine: 'GO נשלח · רותם מחזירה ל-r207',
      short: 'דחוף · טיקיבוט 502',
    ),
    WaitItem(
      id: 'w-ido',
      kind: WaitKind.blockingAsk,
      from: 'ido',
      time: '14:02',
      kicker: "חוסם · עובר ליואב בעוד 7 דק'",
      headline: '37 מנויים שהכרטיס שלהם נדחה: מה עושים?',
      body: 'רותם מצאה 37 מנויים עם כרטיס שנדחה פעמיים השבוע. מה עושים איתם?',
      options: idoOptions,
      askId: 'ask-ido',
      short: 'שאלה · 37 מנויים',
    ),
    WaitItem(
      id: 'w-dana',
      kind: WaitKind.go,
      from: 'dana',
      time: '13:41',
      kicker: 'GO לפרודקשן · לומו 1.1.20',
      headline: 'עדכון ללומו: הטקסט בטלפון מתוקן',
      body: 'תיקון הטקסט בטלפון (#3698). סיכון נמוך. חזרה לגרסה הקודמת לוקחת כדקה.',
      options: const [AskOption(id: 'go', label: 'GO', primary: true)],
      askId: 'ask-dana-go',
      doneLine: 'GO נשלח · דנה מתחילה פריסה',
      links: const [WaitLink(WaitLinkKind.report, 'https://example.com/reports/lumo-1.1.20'), WaitLink(WaitLinkKind.pr, 'https://github.com/hive-owner/lumo/pull/3698')],
      short: 'GO · לומו 1.1.20',
    ),
    WaitItem(
      id: 'w-amit',
      kind: WaitKind.login,
      from: 'amit',
      time: '14:04',
      kicker: 'כניסה לאתר · `mercury.com`',
      body: "נדרש קוד אימות כדי להוריד את דוח אוקטובר. בתוקף עוד 8 דק'.",
      domain: 'app.mercury.com',
      short: 'קוד ל-Mercury',
    ),
  ];

  final ido = Conversation(identityId: 'ido', items: [
    ShiftMarker(id: 'sm2', ts: at(12, 40), shift: 2, from: 1),
    UserMsg(id: 'u1', ts: at(12, 41), text: 'עידו, מה עם התשלומים שנכשלים? משה אמר שיש משתמשים שחויבו פעמיים', delivery: Delivery.read),
    TextMsg(
        id: 't1',
        ts: at(12, 43),
        text: 'בדקתי. אין חיוב כפול. הבעיה היא ניסיון חוזר מיידי אחרי `card_declined`. הלולאה ב-`renew.go` מנסה שוב בלי השהיה, ו-Stripe מחזיר את אותה שגיאה. משה רואה שתי שורות "נכשל" וזה נראה כמו חיוב כפול.\n\nאני משנה את זה כך שהניסיון השני יהיה אחרי 24 שעות.'),
    ToolGroup(id: 'tg1', ts: at(12, 44), summary: "קרא 4 קבצים · חיפש פעמיים · 21 שנ'", tools: const [
      ToolLine(icon: 'description', label: 'internal/billing/renew.go', trail: '1–220'),
      ToolLine(icon: 'description', label: 'internal/billing/stripe.go', trail: '40–96'),
      ToolLine(icon: 'search', label: '"ErrCardDeclined" in internal/', trail: '7'),
      ToolLine(icon: 'description', label: 'internal/billing/renew_test.go', trail: '1–160'),
      ToolLine(icon: 'search', label: '"retry" in internal/billing/', trail: '3'),
      ToolLine(icon: 'description', label: 'DECISIONS.md', trail: 'תשלומים'),
    ]),
    DiffCard(id: 'd1', ts: at(12, 48), note: 'ניסיון שני אחרי 24 שעות, ובלי ניסיון שלישי', prRef: '#3712', files: const [
      DiffFile(path: 'internal/billing/renew.go', add: 12, del: 3, hunks: [
        DiffHunk('@@ -58,9 +58,18 @@ func (r *Renewer) charge(ctx, sub Sub) error', [
          DiffLine(DiffLineKind.ctx, 58, '  err := r.stripe.Charge(ctx, sub.CustomerID, sub.Amount)'),
          DiffLine(DiffLineKind.del, 59, '  if errors.Is(err, ErrCardDeclined) {'),
          DiffLine(DiffLineKind.del, 60, '    return r.charge(ctx, sub) // retry now', marks: ['// retry now']),
          DiffLine(DiffLineKind.add, 59, '  if errors.Is(err, ErrCardDeclined) && sub.Attempts == 0 {'),
          DiffLine(DiffLineKind.add, 60, '    return r.queue.Schedule(sub.ID, 24*time.Hour)', marks: ['24*time.Hour']),
          DiffLine(DiffLineKind.add, 61, '  }'),
          DiffLine(DiffLineKind.add, 62, '  if errors.Is(err, ErrCardDeclined) {'),
          DiffLine(DiffLineKind.add, 63, '    log.Info("renew: declined twice", "sub", sub.ID)'),
          DiffLine(DiffLineKind.add, 64, '    return ErrNeedsOwnerDecision'),
          DiffLine(DiffLineKind.ctx, 65, '  }'),
        ]),
      ]),
    ]),
    TestResultCard(id: 'tr1', ts: at(12, 50), passed: 142, failed: 2, seconds: 38, failures: const [
      TestFailure('TestRenewDeclinedCard', 'renew_test.go:88', 'expected retry at +24h, got +0s'),
      TestFailure('TestRenewTwice', 'renew_test.go:131', 'want 2 charges, got 1'),
    ]),
    TextMsg(id: 't2', ts: at(12, 52), text: 'שתי הבדיקות מצפות לניסיון מיידי, וזה בדיוק מה שהשתנה. עדכנתי אותן.'),
    TerminalCard(id: 'term1', ts: at(12, 55), command: 'go test ./internal/billing/...', totalLines: 412, footer: 'בדיקות · 144 עברו', tail: const [
      '--- PASS: TestRenewDeclinedCard (0.01s)',
      '--- PASS: TestRenewTwice (0.01s)',
      'ok   lumo/internal/billing   1.92s',
    ]),
    EventLine(id: 'new1', ts: at(13, 57), text: '2 הודעות חדשות', strong: true),
    EventLine(id: 'ev1', ts: at(13, 57), icon: 'forward', text: 'עידו ביקש מרותם לבדוק בלוגים כמה חידושים נכשלו השבוע'),
    PrCard(id: 'pr1', ts: at(13, 58), number: 3712, title: 'תשלומים: ניסיון שני לכרטיס שנדחה', ci: Check.ok, review: Check.running, add: 48, del: 11, files: 4, fileList: const [
      DiffFile(path: 'internal/billing/renew.go', add: 12, del: 3),
      DiffFile(path: 'internal/billing/renew_test.go', add: 22, del: 6),
      DiffFile(path: 'internal/billing/queue.go', add: 11, del: 0),
      DiffFile(path: 'DECISIONS.md', add: 3, del: 2),
    ]),
    AskCard(
        id: 'a1',
        ts: at(14, 2),
        askId: 'ask-ido',
        from: 'ido',
        headline: '37 מנויים שהכרטיס שלהם נדחה: מה עושים?',
        question: 'רותם מצאה 37 מנויים עם כרטיס שנדחה פעמיים השבוע. מה עושים איתם?',
        escalation: "עוברת ליואב בעוד 7 דק'",
        options: idoOptions),
  ]);

  final dana = Conversation(
    identityId: 'dana',
    live: const LiveState(phase: LivePhase.writing),
    draft: 'ושגם ה-web יקבל את התיקון',
    items: [
      UserMsg(id: 'du1', ts: at(11, 20), text: 'שה-APK יתקן את הטקסט בטלפון, ותעדכני מתי זה מוכן', delivery: Delivery.read),
      TextMsg(id: 'dt1', ts: at(11, 21), text: 'פתחתי צוות משימה, שירה על זה. זמן משוער: 13:30.'),
      EventLine(id: 'dev1', ts: at(11, 22), text: 'דנה פתחה צוות משימה `t3698` · שירה'),
      TextMsg(id: 'dt2', ts: at(13, 24), text: 'מוכן, 6 דקות לפני הזמן. שירה בדקה את `lumo-1.1.20-24-universal.apk` על CPH2653. הטקסט תקין בעברית ובאנגלית, גם בגופן מוגדל.'),
      GoCard(
        id: 'dg1',
        ts: at(13, 41),
        askId: 'ask-dana-go',
        from: 'dana',
        headline: 'עדכון ללומו: הטקסט בטלפון מתוקן',
        details: '**מה נכנס:** תיקון הטקסט בטלפון (#3698), גרסה 1.1.20\n'
            '**סיכון:** נמוך. קובץ אחד באפליקציה. הבדיקות והסקירה עברו.\n'
            '**חזרה:** `deploy.sh rollback 1.1.19`, כדקה',
      ),
      DecidedCard(id: 'dd1', ts: at(13, 40), by: 'yoav', time: '13:40', text: 'ההעלאה ל-Play תהיה ל-`internal` ולא ל-`production`, כי עוד לא ניתן GO.'),
      UserMsg(id: 'du2', ts: at(14, 5), text: 'מה עם ההודעה למשה על הגרסה?', delivery: Delivery.read),
      TextMsg(id: 'dt3', ts: at(14, 5), streaming: true, text: 'משה יקבל הודעה ברגע שיינתן GO. אני מכינה לו רשימת שינויים קצרה בעברית, בלי מספרי טיקטים'),
      UserMsg(id: 'du3', ts: at(14, 6), text: 'ותוסיפי לרשימה גם את #3711 כשהוא ימוזג', delivery: Delivery.queued),
    ],
  );

  Conversation simple(String id, List<ChatItem> items, {LiveState live = const LiveState()}) =>
      Conversation(identityId: id, items: items, live: live);

  final chats = {
    'ido': ido,
    'dana': dana,
    'yoav': simple('yoav', [
      TextMsg(id: 'y1', ts: at(9, 12), text: 'הלילה נסגר: 12 מיזוגים, 2 מחכים ל-GO.'),
    ]),
    'rotem': simple('rotem', [
      TextMsg(id: 'r1', ts: at(14, 0), text: 'טיקיבוט: ה-webhook מחזיר 502 מ-13:58'),
      AskCard(
        id: 'r2',
        ts: at(14, 0),
        askId: 'ask-rotem',
        from: 'rotem',
        question: 'ה-webhook של וואטסאפ מחזיר 502 מ-13:58, כנראה מהפריסה של 13:55. ההצעה: לחזור ל-`r207`.',
        options: const [AskOption(id: 'go', label: 'GO לחזרה', primary: true), AskOption(id: 'q', label: 'שאלה')],
      ),
    ]),
    'noa': simple('noa', [TextMsg(id: 'n1', ts: at(14, 5), text: 'מריצה `flutter test` על הנגן ב-web')],
        live: const LiveState(phase: LivePhase.tool, label: 'מריצה בדיקות', seconds: 14, runningCommand: 'flutter test')),
    'itai': simple('itai', [TextMsg(id: 'i1', ts: at(13, 44), text: 'אותה בדיקה נכשלת כבר 20 דקות')]),
    'amit': simple('amit', [
      TextMsg(id: 'am1', ts: at(14, 4), text: 'נדרש קוד אימות ל-Mercury'),
      HandoffCard(id: 'am2', ts: at(14, 4), domain: 'mercury.com', expires: "בתוקף עוד 8 דק'"),
    ]),
    'noga': simple('noga', [TextMsg(id: 'ng1', ts: at(13, 57), text: '14 זיכרונות כפולים אוחדו הלילה')]),
    'eli': simple('eli', [TextMsg(id: 'e1', ts: at(9, 0), text: 'הפוליסה חודשה. אין צורך לעשות דבר.')]),
  };

  const convs = [
    ConversationSummary(identityId: 'yoav', lastLine: 'הלילה נסגר: 12 מיזוגים, 2 מחכים ל-GO.', time: '09:12', pinned: true),
    ConversationSummary(identityId: 'ido', lastLine: 'שאלה: כרטיס שנדחה פעמיים בחידוש…', time: '14:02', lastIsMine: true, unread: 2, diffStat: '+48 −11'),
    ConversationSummary(identityId: 'rotem', lastLine: 'טיקיבוט: ה-webhook מחזיר 502 מ-13:58', time: '14:00', lastIsMine: true),
    ConversationSummary(identityId: 'dana', lastLine: 'משה יקבל הודעה ברגע שיינתן GO…', time: '14:05'),
    ConversationSummary(identityId: 'noa', lastLine: 'מריצה `flutter test` על הנגן ב-web', time: '14:05', diffStat: '+31 −6'),
    ConversationSummary(identityId: 'itai', lastLine: 'אותה בדיקה נכשלת כבר 20 דקות', time: '13:44', extra: '· יואב פתח לו עוזר'),
    ConversationSummary(identityId: 'amit', lastLine: 'נדרש קוד אימות ל-Mercury', time: '14:04', lastIsMine: true),
    ConversationSummary(identityId: 'noga', lastLine: '14 זיכרונות כפולים אוחדו הלילה', time: '13:57', unread: 3, muted: true),
    ConversationSummary(identityId: 'eli', lastLine: 'הפוליסה חודשה. אין צורך לעשות דבר.', time: 'אתמול'),
  ];

  const tickets = [
    Ticket(number: '#3711', title: 'תשלומים נכשלים בחידוש מנוי', project: 'lumo', projectName: 'לומו', group: TicketGroup.waiting, assignee: 'עידו', sub: null, status: WorkerStatus.waiting, endLine: '14:02'),
    Ticket(number: '#3698', title: 'טקסט שבור בטלפון מאז 1.1.5', project: 'lumo', projectName: 'לומו', group: TicketGroup.waiting, assignee: 'דנה', sub: 'GO לפרודקשן', status: WorkerStatus.waiting, endLine: '13:41'),
    Ticket(number: '#88', title: 'מחירי נסיעות לפי שעה', project: 'voice', projectName: 'הבוט הקולי', group: TicketGroup.attention, assignee: 'מאיה', sub: 'מחכה לגישה ל-k8s', status: WorkerStatus.blocked, endLine: '13:30'),
    Ticket(number: '#209', title: 'פרסור "בעוד שבועיים"', project: 'easy', projectName: 'טיקיבוט', group: TicketGroup.attention, assignee: 'איתי', sub: "בדיקה נכשלת 20 דק'", status: WorkerStatus.stuck, endLine: '13:44'),
    Ticket(number: '#3720', title: 'הודעות קוליות לא מתנגנות ב-web', project: 'lumo', projectName: 'לומו', group: TicketGroup.working, assignee: 'נועה', sub: 'מריצה בדיקות', status: WorkerStatus.working, diffStat: '+31 −6'),
    Ticket(number: '#215', title: 'סינון קבוצות כפולות', project: 'easy', projectName: 'טיקיבוט', group: TicketGroup.working, assignee: 'גיל', status: WorkerStatus.working, endLine: "לפני 4 דק'"),
    Ticket(number: '#12', title: 'דוח שבועי של מדדי האיכות', project: 'co', projectName: 'החברה', group: TicketGroup.working, assignee: 'נגה', status: WorkerStatus.working, endLine: "לפני 9 דק'"),
  ];

  final detail = TicketDetail(
    ticket: tickets.first,
    statusLine: 'מחכה לך · שאלה מ-14:02',
    pairs: const [
      ('עובד', 'עידו · מפתח'),
      ('צוות', 'לומו · `t3711`'),
      ('נפתח', 'היום 12:38 · דנה'),
      ('ענף', '`t3711-renew-retry`'),
      ('PR', '`#3712` · CI עבר · סקירה רצה'),
      ('שינויים', '`+48 −11` · 4 קבצים'),
    ],
    timeline: const [
      TimelineEntry(icon: 'front_hand', filled: true, text: 'שאלה אליך: מה עושים עם 37 המנויים', time: '14:02', link: 'בשיחה'),
      TimelineEntry(icon: 'call_merge', text: 'PR נפתח, CI עבר', time: '13:58'),
      TimelineEntry(icon: 'checklist', text: '144 בדיקות עברו אחרי עדכון של 2', time: '12:55', link: 'למה עודכנו?'),
      TimelineEntry(icon: 'edit', text: 'ניסיון שני נקבע ל-24 שעות אחרי דחייה', time: '12:48', link: 'למה?'),
      TimelineEntry(icon: 'autorenew', text: 'משמרת 2 התחילה, עם העברה', time: '12:40'),
      TimelineEntry(icon: 'add', text: 'דנה פתחה את הטיקט מהודעה של משה', time: '12:38'),
    ],
  );

  const orgTeams = [
    OrgTeam(teamId: 'mgmt', line: 'יואב · מנהל החברה', statusIcon: 'radio_button_unchecked', statusWord: 'פנוי'),
    OrgTeam(teamId: 'monitor', line: 'רותם · 6 פרויקטים בפרודקשן', statusIcon: 'front_hand', statusWord: 'מחכה לך', bold: true),
    OrgTeam(teamId: 'personal', line: 'אלי · 3 מומחים', statusIcon: 'front_hand', statusWord: '1 מחכה לך', bold: true),
    OrgTeam(teamId: 'improve', line: 'נגה', statusIcon: 'play_arrow', statusWord: 'עובדת'),
    OrgTeam(teamId: 'lumo', line: 'פעיל · 3 עובדים', statusIcon: '', statusWord: '', members: [
      OrgMember(identityId: 'dana', line: 'מנכ"לית לומו · משמרת 7'),
      OrgMember(identityId: 'ido', line: 'מפתח · משמרת 2', group: 'צוות משימה `t3711` · תשלומים נכשלים', sub: true),
      OrgMember(identityId: 'noa', line: 'מפתחת · משמרת 1', group: 'צוות משימה `t3720` · נגן קולי ב-web', sub: true),
      OrgMember(identityId: 'tamar', line: 'מומחית הפריסות של לומו', group: 'מומחים רדומים', sub: true),
    ]),
    OrgTeam(teamId: 'tikibot', line: 'פעיל · גיל, איתי', statusIcon: 'warning', statusWord: '1 תקוע', bold: true),
    OrgTeam(teamId: 'voice', line: 'רדום · הניטור ממשיך', statusIcon: '', statusWord: '', canWake: true),
  ];

  return CompanyData(
    managerId: 'yoav',
    teams: teams,
    identities: ids,
    presence: presence,
    waiting: waiting,
    decisions: const [DecisionByManager(by: 'yoav', text: 'ההעלאה ל-Play תהיה ל-`internal`, כי עוד לא ניתן GO.', time: '13:40')],
    digest: const [
      'בלומו מוזגו 4 שינויים. 1.1.20 מחכה ל-GO.',
      'בטיקיבוט תוקן הפרסור של "ביום ה-שני" (#211).',
      'בבוט הקולי עלו מחירי הנסיעות ל-`live-v5`, כשלא הייתה שיחה פעילה.',
    ],
    digestSince: '09:12',
    activity: const [
      TeamActivity(symbol: 'local_shipping', team: 'לומו', line: '3 עובדים · נועה מריצה בדיקות'),
      TeamActivity(symbol: 'smart_toy', team: 'טיקיבוט', line: '2 עובדים · איתי תקוע על בדיקה'),
      TeamActivity(symbol: 'build', team: 'החברה', line: 'נגה כותבת את הדוח השבועי'),
      TeamActivity(symbol: 'graphic_eq', team: 'הבוט הקולי', line: 'רדום · הניטור ממשיך', dormant: true),
    ],
    conversations: [...convs],
    chats: chats,
    tickets: tickets,
    ticketDetails: {'#3711': detail},
    boardSubtitle: 'כל החברה · 14 פתוחים · 6 הושלמו היום',
    orgTeams: orgTeams,
    orgSubtitle: '9 עובדים פעילים · 6 נחים',
    capacity: const [Capacity('hq-host', '4 מתוך 5 משבצות'), Capacity('ci-host', '2 מתוך 3'), Capacity('לפטופ', 'כבוי', off: true, mono: false)],
    automations: [
      Automation(key: 'probes', team: 'ניטור', sentence: 'רותם בודקת את כל הפרודקשן כל 5 דקות', meta: 'אחרונה 14:05 · נכשלה בטיקיבוט · הבאה 14:10'),
      Automation(key: 'certs', team: 'ניטור', sentence: 'רותם בודקת תעודות ודומיינים כל יום ב-07:00', meta: 'אחרונה 07:00 · תקין'),
      Automation(key: 'morning', team: 'הנהלה', sentence: 'יואב שולח סיכום בוקר ב-08:30', meta: 'אחרונה 08:30 · נשלח'),
      Automation(key: 'dream', team: 'מחלקת השיפור', sentence: 'נגה מאחדת את הזיכרון כל לילה ב-04:00', meta: 'אחרונה 04:00 · 14 כפילויות אוחדו'),
      Automation(key: 'backtest', team: 'מחלקת השיפור', sentence: 'נגה בודקת לאחור מודלים בכל יום ראשון', meta: "אחרונה א' 18/10 · הבאה א' 25/10"),
      Automation(key: 'reviews', team: 'לומו', sentence: 'דנה קוראת ביקורות חדשות ב-Play כל יום ב-10:00', meta: 'כובתה ידנית · 18/10', enabled: false),
    ],
    awaiting: [
      AwaitingTask(id: 3720, kind: AwaitingKind.check, title: 'אפליקציה: תמונות בצ\'אט', summary: 'התמונות בצ\'אט עולות גם מהטלפון', note: 'לשלוח תמונה מהטלפון ולראות שהיא עולה', identity: 'noa', project: 'lumo', at: at(13, 20)),
      AwaitingTask(id: 3711, kind: AwaitingKind.deploy, title: 'לומו: שעת איסוף', summary: 'שעת איסוף "לא ידוע" לא נאמרת ללקוח', note: 'מחכה ל-GO שלך', identity: 'ido', project: 'lumo', at: at(11, 5)),
    ],
    asked: [
      // Open: his last line to Dana, no answer yet. Answered: Ido's answer (t1) to his question (u1), not read yet.
      AskedRequest(id: 'du3', identity: 'dana', body: 'ותוסיפי לרשימה גם את #3711 כשהוא ימוזג', at: at(14, 6)),
      AskedRequest(
        id: 'u1',
        identity: 'ido',
        body: 'עידו, מה עם התשלומים שנכשלים? משה אמר שיש משתמשים שחויבו פעמיים',
        at: at(12, 41),
        state: AskedState.answered,
        reply: AskedReply(id: 't1', body: 'בדקתי. אין חיוב כפול. הבעיה היא ניסיון חוזר מיידי אחרי `card_declined`.', at: at(12, 43)),
      ),
    ],
  );
}


/// The demo's machines: one busy, with a task waiting for it, one quiet, one that could not be read.
ResourcesView demoResources() => ResourcesView.fromJson({
      'machines': [
        {
          'name': 'local', 'label': 'hq-host', 'measured': true, 'unmeasured': <String>[],
          'mem': {'total_mb': 23437, 'avail_mb': 6000, 'used_mb': 17437}, 'load1': 3.2, 'cpus': 8,
          'disk': {'pct': 71, 'free_mb': 120000},
          'holders': [
            {'project': 'lumo', 'name': 'לומו', 'mem_mb': 6246, 'cpu_pct': 41.5, 'count': 3},
            {'project': 'agent-company', 'name': 'החברה', 'mem_mb': 9216, 'cpu_pct': 12.0, 'count': 5},
            {'project': null, 'name': 'לא מזוהה', 'mem_mb': 7168, 'cpu_pct': null, 'count': 1},
          ],
          'unidentified': [
            {'kind': 'other', 'name': 'system.slice/gradle.service', 'mem_mb': 7168},
          ],
        },
        {
          'name': 'ci-host', 'label': 'ci-host', 'measured': true, 'unmeasured': ['docker'],
          'mem': {'total_mb': 15000, 'avail_mb': 12000, 'used_mb': 3000}, 'load1': 0.2, 'cpus': 4,
          'disk': {'pct': 88, 'free_mb': 20000},
          'holders': [
            {'project': 'lumo', 'name': 'לומו', 'mem_mb': 2048, 'cpu_pct': 5.0, 'count': 1},
          ],
          'unidentified': <Object>[],
        },
        {
          'name': 'srv1000001', 'label': 'srv1000001', 'measured': false, 'error': 'ssh timeout', 'unmeasured': ['memory', 'disk', 'cgroups', 'docker'],
          'holders': <Object>[], 'unidentified': <Object>[],
        },
      ],
      'waiting': [
        {'task': 292, 'ref': null, 'title': 'תיקון דחוף בשרת', 'project': 'agent-company', 'waiting_min': 4, 'waiting_for': 'צרכן לא מזוהה מחזיק 7.0GB', 'eta_min': 12},
      ],
      'leases': [
        {'id': 'lease-11', 'machine': 'local', 'class': 'build', 'state': 'granted', 'task': 351, 'project': 'lumo', 'project_name': 'לומו', 'mem_mb': 8192, 'note': 'APK', 'age_min': 12, 'eta_min': 14},
        {'id': 'lease-12', 'machine': 'local', 'class': 'build', 'state': 'queued', 'task': 400, 'project': 'agent-company', 'project_name': 'החברה', 'mem_mb': 8192, 'note': null, 'age_min': 3, 'eta_min': 14, 'waiting_for': 'build של לומו (משימה 351)'},
      ],
    });
