// The screenshots in the public README and on the landing page (docs/assets/screenshots/): the real app,
// rendered with the test fonts, on a neutral English sample company. Nothing in it is a real person, server or
// project. They are goldens, so a change to a screen shows up here too: refresh them with
//   flutter test --update-goldens test/readme_screenshots_test.dart
import 'package:agent_company/data/backend.dart';
import 'package:agent_company/data/fake_backend.dart';
import 'package:agent_company/model/models.dart';
import 'package:agent_company/model/task_progress.dart';
import 'package:agent_company/ui/chat/chat_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'helpers.dart' show kDemoNow;
import 'product_test.dart' show productApp;

/// The sample company, connected (no demo banner).
class SampleBackend extends FakeBackend {
  SampleBackend() : super(simulate: false, now: kDemoNow);
  CompanyData? _sample;

  @override
  CompanyData? get data => _sample;

  @override
  SystemStatus get status => const SystemStatus(LinkState.online);

  /// The open tasks, so the desktop's side panel shows Sam's work instead of an empty list.
  @override
  Future<List<TaskProgress>> taskProgress() async {
    DateTime at(int h, int m) => DateTime(kDemoNow.year, kDemoNow.month, kDemoNow.day, h, m);
    return [
      TaskProgress(id: 212, title: 'Retry a declined card once, after 24 hours', project: 'billing-api', worker: 'sam', openedBy: 'maya',
          stage: TaskStage.review, state: 'running', createdAt: at(12, 38), startedAt: at(12, 40), updatedAt: at(14, 2)),
      TaskProgress(id: 209, title: "Send the receipt email in the customer's language", project: 'billing-api', worker: 'sam', openedBy: 'maya',
          stage: TaskStage.released, state: 'done', createdAt: at(9, 5), startedAt: at(9, 10), updatedAt: at(11, 30)),
    ];
  }

  @override
  Future<void> start() async {
    _sample = sampleCompany((h, m) => DateTime(kDemoNow.year, kDemoNow.month, kDemoNow.day, h, m));
    notifyListeners();
  }
}

const _out = '../../../docs/assets/screenshots';

void main() {
  testWidgets('readme: desktop', (tester) async {
    await productApp(tester, backend: SampleBackend(), size: const Size(1280, 800));
    await tester.pump(const Duration(milliseconds: 500));
    expect(tester.takeException(), isNull);
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('$_out/desktop.png'));
  });

  testWidgets('readme: desktop dark', (tester) async {
    await productApp(tester, backend: SampleBackend(), dark: true, size: const Size(1280, 800));
    await tester.pump(const Duration(milliseconds: 500));
    expect(tester.takeException(), isNull);
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('$_out/desktop-dark.png'));
  });

  testWidgets('readme: phone chats', (tester) async {
    await productApp(tester, backend: SampleBackend());
    await tester.pump(const Duration(milliseconds: 500));
    expect(tester.takeException(), isNull);
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('$_out/phone-chats.png'));
  });

  testWidgets('readme: phone chat', (tester) async {
    await productApp(tester, backend: SampleBackend(), home: const ChatScreen(identityId: 'sam'));
    await tester.pump(const Duration(milliseconds: 500));
    expect(tester.takeException(), isNull);
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('$_out/phone-chat.png'));
  });

  testWidgets('readme: phone chat dark', (tester) async {
    await productApp(tester, backend: SampleBackend(), dark: true, home: const ChatScreen(identityId: 'sam'));
    await tester.pump(const Duration(milliseconds: 500));
    expect(tester.takeException(), isNull);
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('$_out/phone-chat-dark.png'));
  });
}

// ───────────────────────────── the sample company (20/10/2026 14:06) ─────────────────────────────

CompanyData sampleCompany(DateTime Function(int h, int m) at) {
  const teams = {
    'mgmt': Team(id: 'mgmt', name: 'Management', symbol: 'explore', leadId: 'maya', tone: 'slate'),
    'monitor': Team(id: 'monitor', name: 'Monitoring', symbol: 'shield', leadId: 'leo', tone: 'slate'),
    'improve': Team(id: 'improve', name: 'Improvement', symbol: 'build', leadId: 'iris', tone: 'slate'),
    'web': Team(id: 'web', name: 'storefront', symbol: 'storefront', leadId: 'nora', permanent: false, tone: 'teal'),
    'api': Team(id: 'api', name: 'billing-api', symbol: 'api', permanent: false, tone: 'clay'),
    'mobile': Team(id: 'mobile', name: 'mobile', symbol: 'smartphone', permanent: false, tone: 'sky'),
  };
  const ids = {
    'maya': Identity(id: 'maya', name: 'Maya', title: 'Manager', teamId: 'mgmt', gender: Gender.f),
    'leo': Identity(id: 'leo', name: 'Leo', title: 'Monitoring lead', short: 'Monitoring', teamId: 'monitor'),
    'sam': Identity(id: 'sam', name: 'Sam', title: 'Developer', teamId: 'api', temp: true, taskRef: 't212'),
    'nora': Identity(id: 'nora', name: 'Nora', title: 'Project lead', teamId: 'web', gender: Gender.f),
    'jules': Identity(id: 'jules', name: 'Jules', title: 'Developer', teamId: 'web', temp: true, taskRef: 't218'),
    'omar': Identity(id: 'omar', name: 'Omar', title: 'QA', teamId: 'mobile', temp: true),
    'iris': Identity(id: 'iris', name: 'Iris', title: 'Improvement lead', short: 'Improvement', teamId: 'improve', gender: Gender.f),
    'tess': Identity(id: 'tess', name: 'Tess', title: 'Release specialist', teamId: 'web', gender: Gender.f),
    'kai': Identity(id: 'kai', name: 'Kai', title: 'Developer', teamId: 'mobile'),
  };
  final presence = <String, Presence>{
    'maya': const Presence(status: WorkerStatus.free),
    'leo': const Presence(status: WorkerStatus.working),
    'sam': const Presence(status: WorkerStatus.waiting, shift: 2, shiftSince: '12:40', contextPct: 62),
    'nora': const Presence(status: WorkerStatus.working, activity: 'writing', shift: 4),
    'jules': const Presence(status: WorkerStatus.working, shift: 1),
    'omar': Presence(status: WorkerStatus.stuck, stuckSince: at(13, 24)),
    'iris': const Presence(status: WorkerStatus.working),
    'tess': const Presence(status: WorkerStatus.resting),
    'kai': const Presence(status: WorkerStatus.working),
  };

  const samOptions = [
    AskOption(id: 'retry24', label: 'Retry once after 24 hours', shortLabel: 'Retry after 24h'),
    AskOption(id: 'cancel', label: 'Cancel the subscription now'),
  ];

  final waiting = [
    WaitItem(
      id: 'w-sam',
      kind: WaitKind.blockingAsk,
      from: 'sam',
      time: '14:02',
      kicker: 'Blocking',
      headline: '37 subscriptions with a declined card: what should we do?',
      body: 'Leo found 37 subscriptions whose card was declined twice this week. What should happen to them?',
      options: samOptions,
      askId: 'ask-sam',
      short: 'Question · 37 subscriptions',
    ),
    WaitItem(
      id: 'w-nora',
      kind: WaitKind.go,
      from: 'nora',
      time: '13:41',
      kicker: 'Release · storefront 2.4.1',
      headline: 'storefront 2.4.1: checkout fix',
      body: 'Fixes the checkout button on small screens (#418). Low risk. Rolling back takes about a minute.',
      options: const [AskOption(id: 'go', label: 'GO', primary: true)],
      askId: 'ask-nora-go',
      doneLine: 'GO sent · Nora is deploying',
      short: 'GO · storefront 2.4.1',
    ),
  ];

  final sam = Conversation(identityId: 'sam', items: [
    ShiftMarker(id: 'sm2', ts: at(12, 40), shift: 2, from: 1),
    UserMsg(id: 'u1', ts: at(12, 41), text: 'Sam, what is going on with the failed renewals? Some customers say they were charged twice.', delivery: Delivery.read),
    TextMsg(
        id: 't1',
        ts: at(12, 43),
        text: 'I checked. Nobody was charged twice. The renewal retries immediately after `card_declined`, '
            'the processor returns the same error, and the customer sees two "failed" lines.\n\n'
            'I am changing it so the second attempt runs 24 hours later.'),
    ToolGroup(id: 'tg1', ts: at(12, 44), summary: 'Read 4 files · searched twice · 21s', tools: const [
      ToolLine(icon: 'description', label: 'internal/billing/renew.go', trail: '1–220'),
      ToolLine(icon: 'description', label: 'internal/billing/processor.go', trail: '40–96'),
      ToolLine(icon: 'search', label: '"ErrCardDeclined" in internal/', trail: '7'),
      ToolLine(icon: 'description', label: 'internal/billing/renew_test.go', trail: '1–160'),
    ]),
    TextMsg(id: 't2', ts: at(12, 52), text: 'Two tests expected the immediate retry, which is exactly what changed. I updated them.'),
    TerminalCard(id: 'term1', ts: at(12, 55), command: 'go test ./internal/billing/...', totalLines: 412, footer: 'Tests · 144 passed', tail: const [
      '--- PASS: TestRenewDeclinedCard (0.01s)',
      '--- PASS: TestRenewTwice (0.01s)',
      'ok   billing-api/internal/billing   1.92s',
    ]),
    PrCard(id: 'pr1', ts: at(13, 58), number: 212, title: 'Billing: retry a declined card once, after 24 hours', ci: Check.ok, review: Check.running, add: 48, del: 11, files: 4, fileList: const [
      DiffFile(path: 'internal/billing/renew.go', add: 12, del: 3),
      DiffFile(path: 'internal/billing/renew_test.go', add: 22, del: 6),
      DiffFile(path: 'internal/billing/queue.go', add: 11, del: 0),
      DiffFile(path: 'DECISIONS.md', add: 3, del: 2),
    ]),
    AskCard(
        id: 'a1',
        ts: at(14, 2),
        askId: 'ask-sam',
        from: 'sam',
        headline: '37 subscriptions with a declined card: what should we do?',
        question: 'Leo found 37 subscriptions whose card was declined twice this week. What should happen to them?',
        options: samOptions),
  ]);

  Conversation simple(String id, List<ChatItem> items, {LiveState live = const LiveState()}) =>
      Conversation(identityId: id, items: items, live: live);

  final chats = {
    'sam': sam,
    'maya': simple('maya', [TextMsg(id: 'y1', ts: at(9, 12), text: 'Overnight: 12 pull requests merged, 2 waiting for your GO.')]),
    'nora': simple('nora', [
      TextMsg(id: 'n1', ts: at(13, 41), text: 'storefront 2.4.1 is ready. Tests and review passed.'),
    ], live: const LiveState(phase: LivePhase.writing)),
    'leo': simple('leo', [TextMsg(id: 'l1', ts: at(14, 1), text: 'All production checks are green.')]),
    'jules': simple('jules', [TextMsg(id: 'j1', ts: at(14, 5), text: 'Running `npm test` on the cart page')],
        live: const LiveState(phase: LivePhase.tool, label: 'Running tests', seconds: 14, runningCommand: 'npm test')),
    'omar': simple('omar', [TextMsg(id: 'o1', ts: at(13, 44), text: 'The same UI test has been failing for 20 minutes')]),
    'iris': simple('iris', [TextMsg(id: 'i1', ts: at(13, 57), text: 'Merged 14 duplicate memory notes overnight')]),
    'kai': simple('kai', [TextMsg(id: 'k1', ts: at(13, 30), text: 'Dark mode for the settings screen is in review')]),
  };

  const convs = [
    ConversationSummary(identityId: 'maya', lastLine: 'Overnight: 12 pull requests merged, 2 waiting for your GO.', time: '09:12', pinned: true),
    ConversationSummary(identityId: 'sam', lastLine: '37 subscriptions with a declined card: what should we do?', time: '14:02', unread: 2, diffStat: '+48 −11'),
    ConversationSummary(identityId: 'nora', lastLine: 'storefront 2.4.1 is ready. Tests and review passed.', time: '13:41'),
    ConversationSummary(identityId: 'jules', lastLine: 'Running `npm test` on the cart page', time: '14:05', diffStat: '+31 −6'),
    ConversationSummary(identityId: 'leo', lastLine: 'All production checks are green.', time: '14:01'),
    ConversationSummary(identityId: 'omar', lastLine: 'The same UI test has been failing for 20 minutes', time: '13:44'),
    ConversationSummary(identityId: 'kai', lastLine: 'Dark mode for the settings screen is in review', time: '13:30'),
    ConversationSummary(identityId: 'iris', lastLine: 'Merged 14 duplicate memory notes overnight', time: '13:57', unread: 3, muted: true),
  ];

  const tickets = [
    Ticket(number: '#211', title: 'Renewals fail after a declined card', project: 'api', projectName: 'billing-api', group: TicketGroup.waiting, assignee: 'Sam', status: WorkerStatus.waiting, endLine: '14:02'),
    Ticket(number: '#418', title: 'Checkout button hidden on small screens', project: 'web', projectName: 'storefront', group: TicketGroup.waiting, assignee: 'Nora', sub: 'Waiting for GO', status: WorkerStatus.waiting, endLine: '13:41'),
    Ticket(number: '#77', title: 'Flaky login UI test', project: 'mobile', projectName: 'mobile', group: TicketGroup.attention, assignee: 'Omar', sub: 'Test failing for 20 min', status: WorkerStatus.stuck, endLine: '13:44'),
    Ticket(number: '#421', title: 'Cart totals round the wrong way', project: 'web', projectName: 'storefront', group: TicketGroup.working, assignee: 'Jules', sub: 'Running tests', status: WorkerStatus.working, diffStat: '+31 −6'),
    Ticket(number: '#80', title: 'Dark mode for settings', project: 'mobile', projectName: 'mobile', group: TicketGroup.working, assignee: 'Kai', status: WorkerStatus.working, endLine: '4 min ago'),
  ];

  const orgTeams = [
    OrgTeam(teamId: 'mgmt', line: 'Maya · Manager', statusIcon: 'radio_button_unchecked', statusWord: 'Free'),
    OrgTeam(teamId: 'monitor', line: 'Leo · 3 projects in production', statusIcon: 'play_arrow', statusWord: 'Working'),
    OrgTeam(teamId: 'improve', line: 'Iris', statusIcon: 'play_arrow', statusWord: 'Working'),
    OrgTeam(teamId: 'web', line: 'Active · 3 workers', statusIcon: '', statusWord: '', members: [
      OrgMember(identityId: 'nora', line: 'Project lead · shift 4'),
      OrgMember(identityId: 'jules', line: 'Developer · shift 1', group: 'Task `t218` · cart totals', sub: true),
      OrgMember(identityId: 'tess', line: 'Release specialist', group: 'Resting specialists', sub: true),
    ]),
    OrgTeam(teamId: 'api', line: 'Active · Sam', statusIcon: 'front_hand', statusWord: 'Needs you', bold: true),
    OrgTeam(teamId: 'mobile', line: 'Active · Kai, Omar', statusIcon: 'warning', statusWord: '1 stuck', bold: true),
  ];

  return CompanyData(
    ownerName: 'Alex',
    managerId: 'maya',
    teams: teams,
    identities: ids,
    presence: presence,
    waiting: waiting,
    decisions: const [],
    digest: const [
      'storefront: 4 changes merged. 2.4.1 is waiting for GO.',
      'mobile: the login screen now remembers the last account.',
    ],
    digestSince: '09:12',
    activity: const [
      TeamActivity(symbol: 'storefront', team: 'storefront', line: '3 workers · Jules is running tests'),
      TeamActivity(symbol: 'api', team: 'billing-api', line: '1 worker · Sam is waiting for you'),
      TeamActivity(symbol: 'smartphone', team: 'mobile', line: '2 workers · Omar is stuck on a test'),
    ],
    conversations: [...convs],
    chats: chats,
    tickets: tickets,
    ticketDetails: const {},
    boardSubtitle: 'Whole company · 9 open · 6 done today',
    orgTeams: orgTeams,
    orgSubtitle: '7 active workers · 2 resting',
    capacity: const [],
    automations: const [],
  );
}
