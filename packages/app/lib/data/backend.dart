import 'package:agent_company/l10n/ui_copy.dart';
import 'search.dart';
// The one interface between the UI and a company backend.
// FakeBackend (mockup content) and HqBackend (packages/hq HTTP+WS) both implement it;
// lib/data/backend_select.dart picks one, and that is the only line that changes.
import 'package:flutter/foundation.dart';

import '../model/home_recipe.dart';
import '../model/models.dart';
import '../theme/tokens.dart';
import '../model/map_day.dart';
import '../model/resources.dart';

class CompanyData {
  CompanyData({
    required this.teams,
    required this.identities,
    required this.presence,
    required this.waiting,
    required this.decisions,
    required this.digest,
    required this.digestSince,
    required this.activity,
    required this.conversations,
    required this.chats,
    required this.tickets,
    required this.ticketDetails,
    required this.boardSubtitle,
    required this.orgTeams,
    required this.orgSubtitle,
    required this.capacity,
    required this.automations,
    this.projects = const [],
    this.focus = false,
    this.night,
    this.awaiting = const [],
    this.checks = const [],
    this.asked = const [],
    this.home,
    this.managerId = '',
    this.ownerLanguage = 'en',
    this.ownerName = '',
    this.advancedMode = false,
    this._openTasks,
  });

  /// The company's manager (hq's `manager`, from org.yaml): pinned first in the conversations. '' = an hq that does not say.
  final String managerId;
  final String ownerLanguage;
  final String ownerName;
  final bool advancedMode;

  final Map<String, Team> teams;
  final Map<String, Identity> identities;
  final Map<String, Presence> presence;
  /// What is blocked on him and only on him (task 986): a question, a GO, a sign-in. The rest is the manager's.
  final List<WaitItem> waiting;

  /// Tasks he is asked to check: cards in their worker's conversation ("עובד" / "לא עובד"), never counted as waiting.
  final List<WaitItem> checks;
  final List<DecisionByManager> decisions;

  /// Yoav's digest lines since the last visit (markup), max 5 on home.
  final List<String> digest;
  final String digestSince;
  final List<TeamActivity> activity;
  final List<ConversationSummary> conversations;
  final Map<String, Conversation> chats;
  final List<Ticket> tickets;
  final Map<String, TicketDetail> ticketDetails;
  final String boardSubtitle;
  final List<OrgTeam> orgTeams;
  final String orgSubtitle;
  final List<Capacity> capacity;
  final List<Automation> automations;

  /// org.yaml's projects with their real status (hq `/api/board`). Empty: the board derives them from the tickets.
  final List<ProjectInfo> projects;
  bool focus;

  /// "לילה · 3/3 משבצות · 7 בתור · 2 דולגו" when night mode runs.
  String? night;

  /// "מה לבדוק" (#108): finished tasks that wait for a deploy or for him to check, newest first.
  List<AwaitingTask> awaiting;

  /// "ביקשת" (#118): his requests to workers whose answer he hasn't read, newest first.
  List<AskedRequest> asked;

  /// "בעבודה ובתור" (#128): every task not done, running first, then what waits for him, the queue in its order, the blocked.
  List<OpenTask> get openTasks => _openTasks ?? OpenTask.fromTickets(tickets, leadOf: {for (final p in projects) p.id: teams[p.teamId ?? p.id]?.leadId});

  set openTasks(List<OpenTask> v) => _openTasks = v;

  /// What each task was promised to take (`GET /api/estimates`), by task id; empty from an hq without it.
  Map<int, Estimate> estimates = {};

  /// hq's list; null from an hq before it (and the mockup): derived from the tickets as they are now.
  List<OpenTask>? _openTasks;

  /// The open tasks [identityId] opened: what its row in the conversations shows ("מה פתוח אצלי").
  List<OpenTask> openedBy(String identityId) => [for (final t in openTasks) if (t.openedBy == identityId) t];

  /// The head of the conversations screen (GET /api/home); null from an hq without it (the screen draws hq's default shape itself).
  HomeRecipe? home;

  /// His latest messages both ways (hq: the last 200), newest first: what v2's search reads for content.
  List<RecentLine> recent = [];

  int get waitingCount => waiting.where((w) => (w.state == WaitState.open || w.state == WaitState.pending) && !superseded(w)).length;

  /// A GO request with a newer one open from the same worker (#258): only the newest asks him; the older
  /// ones fold to "הוחלפה בבקשה חדשה" and leave "מחכה לך".
  bool superseded(WaitItem w) {
    if (w.kind != WaitKind.go) return false;
    bool open(WaitItem x) => x.state == WaitState.open || x.state == WaitState.pending || x.state == WaitState.notNow;
    return waiting.any((x) => !identical(x, w) && x.kind == WaitKind.go && x.from == w.from && open(x) && _newer(x, w));
  }

  /// Raised after: by hq's time, else by its inbox id, else by its place in the list.
  bool _newer(WaitItem a, WaitItem b) {
    if (a.createdAt != null && b.createdAt != null && a.createdAt != b.createdAt) return a.createdAt!.isAfter(b.createdAt!);
    if (a.inboxId != null && b.inboxId != null) return a.inboxId! > b.inboxId!;
    return waiting.indexOf(a) > waiting.indexOf(b);
  }

  /// The number on "שיחות" and the app icon: unread messages, muted conversations left out (as in WhatsApp).
  int get unreadCount => conversations.fold(0, (n, c) => c.muted ? n : n + c.unread);

  ConversationSummary? conversation(String identityId) => conversations.where((c) => c.identityId == identityId).firstOrNull;

  Identity who(String id) => identities[id] ?? (id == kSystemId ? kSystem : Identity(id: id, name: id, title: '', teamId: ''));

  /// A worker the owner can talk to. hq itself (the accounts manager, pairing, failures) is not:
  /// it has no conversation, and a message to it reaches no one (#55).
  bool canChat(String id) => id != kSystemId;
  Team? teamOf(String identityId) => teams[identities[identityId]?.teamId];

  /// "מפתחת · voice-bot": the title, then the team or project the worker belongs to, wherever a worker is
  /// shown (#40). The team is left out when the title already names it ("מנכ"לית החברה").
  String roleLine(String identityId, {bool short = false}) {
    final who = this.who(identityId);
    final title = short ? who.short : who.title;
    final team = teamOf(identityId);
    if (team == null || team.name.isEmpty) return title;
    if (title.contains(team.name) || title.contains(team.id)) return title;
    // A Latin name ("voice-bot") is isolated, so its hyphen stays inside it in the RTL line.
    final name = RegExp(r'[\u0590-\u05FF]').hasMatch(team.name) ? team.name : ltr(team.name);
    return title.isEmpty ? name : '$title · $name';
  }

  /// A finished task worker (APP-SPEC §4.3): its conversation shows "הושלם" and goes below the live ones.
  bool isDone(String identityId) => who(identityId).temp && presence[identityId]?.status == WorkerStatus.done;
}

/// One message from [CompanyData.recent]: whose conversation, its first line, when, and whether he wrote it.
typedef RecentLine = ({String id, String text, DateTime at, bool mine});

/// Result of a command that reaches the server. Failure text is one plain sentence (design-taste §7).
class CommandResult {
  const CommandResult.ok() : ok = true, _error = null, copyId = null, transient = false, gone = false;
  const CommandResult.fail(String? error, {this.transient = false, this.gone = false}) : _error = error, copyId = null, ok = false; // ignore: prefer_initializing_formals
  const CommandResult.localized(this.copyId, {this.transient = false, this.gone = false}) : _error = null, ok = false;
  final bool ok;
  final String? _error;
  final int? copyId;
  String? get error => copyId == null ? _error : UiCopy.text(copyId!);

  /// It never got an answer from hq (no link, a timeout, the proxy while hq restarts): the same
  /// request may go again later. A refusal (4xx) is not transient.
  final bool transient;

  /// hq answered that the item is already handled or gone (404/409): a race with another device or a
  /// worker, not a fault. Shown, not sent as an error.
  final bool gone;
}

/// One Claude account as the switch button in settings shows it (B.7).
class AccountInfo {
  const AccountInfo({required this.name, required this.label, required this.usable, this.room, this.note, this.blocked = false});
  final String name;
  final String label;
  final bool usable;
  final bool blocked;

  /// Percent left in the tighter window (5 hours / week), when known.
  final num? room;
  final String? note;
}

class AccountsView {
  const AccountsView({required this.accounts, this.pinned, this.active});
  final List<AccountInfo> accounts;

  /// "כולם ל-X"; null = automatic.
  final String? pinned;
  final String? active;
}

abstract class Backend extends ChangeNotifier {
  /// Stable company boundary for drafts and uploaded attachment ids.
  String? get storageScope => null;
  CompanyData? get data;
  SystemStatus get status;

  /// Short label shown in settings: "הדגמה" or the server host.
  String get label;

  Future<void> start();
  /// Reformat client-derived labels from retained input, without changing worker content.
  void relocalize() {}

  Future<List<SearchHit>> search(String query) async => searchLocal(data, query);

  Future<CommandResult> answerAsk(String askId, AskOption option, {String? from});
  /// Free text (and images, [UserMsg.attachments] style) as the answer to a question.
  Future<CommandResult> freeAnswer(String askId, String text, {List<Attachment> attachments = const []});
  Future<CommandResult> go(WaitItem item);
  /// "לא עכשיו": the item stays open, below the rest, on every device and after a refresh.
  Future<CommandResult> notNow(WaitItem item);

  /// Takes back a "לא עכשיו" (its "ביטול").
  Future<CommandResult> resume(WaitItem item);

  /// "בוצע" (`done`), "נכשל" (`failed`) or "לא רלוונטי" (`irrelevant`, #297) on a finished task's card (#219): it
  /// leaves "מחכה לך" and "מה לבדוק", and on the last two whoever opened the task is told which.
  Future<CommandResult> awaitingOutcome(WaitItem item, String outcome) async {
    item.state = WaitState.answered;
    final d = data;
    final task = int.tryParse(item.ref?.replaceFirst('task-', '') ?? '');
    if (d != null && task != null) d.awaiting = [for (final x in d.awaiting) if (x.id != task) x];
    notifyListeners();
    return const CommandResult.ok();
  }

  /// Closes the item without doing it; the worker who asked is told.
  Future<CommandResult> dismiss(WaitItem item);
  Future<CommandResult> retry(WaitItem item);

  /// Sends a message; the backend updates [UserMsg.delivery] as acks come in.
  Future<CommandResult> send(String identityId, UserMsg msg);

  /// The bytes of an attached image the server holds (`GET /api/uploads/:id`); null when it can't.
  Future<Uint8List?> attachmentData(String id) async => null;
  Future<CommandResult> retract(String identityId, String msgId);
  Future<CommandResult> stop(String identityId);
  Future<CommandResult> setAutomation(String key, bool enabled);
  Future<CommandResult> setFocus(bool on);
  Future<CommandResult> wake(String teamId);
  Future<CommandResult> handoffDone(WaitItem item);

  /// B.7 accounts for the switch button; null when this backend has none (the demo).
  Future<AccountsView?> accounts() async => null;

  /// "כולם ל-X": new shifts go to [name], live ones move at their next turn boundary. null = automatic.
  Future<CommandResult> pinAccount(String? name) async =>  CommandResult.localized(784);

  /// Called when a conversation opens (hq: replay events for that identity).
  Future<void> openConversation(String identityId) async {}

  /// A chat screen for [identityId] is now on screen (pushed, or switched to on desktop). Paired
  /// with [closeConversation]; the most recent one still on screen is the open conversation.
  void showConversation(String identityId) {}

  /// That screen left: what arrives for it from now on is not "read" (unless another screen for
  /// the same worker is still showing).
  void closeConversation(String identityId) {}

  /// The app came to the front or went to the background: an open conversation is read only while he sees it,
  /// and a message there alerts him only when he doesn't.
  void setVisible(bool visible) {}

  /// When he last left [screen] ("chats"), as the server keeps it for all his devices; null when it has none.
  DateTime? seenAt(String screen) => null;

  /// He left [screen] at [at]: what happens after it is "מאז שהיית פה" next time, on every device.
  Future<void> markSeen(String screen, DateTime at) async {}

  /// "בדקתי" (#108): [t] leaves "מה לבדוק" at once, on every device; it comes back when the server didn't take it.
  Future<CommandResult> checked(AwaitingTask t) async {
    final d = data;
    if (d != null) {
      d.awaiting = [for (final x in d.awaiting) if (x.id != t.id) x];
      notifyListeners();
    }
    return const CommandResult.ok();
  }

  /// One day of the company for the map ("2026-10-21"); null when it can't be had. Every message is a line without its text.
  Future<MapDay?> companyDay(String date) async => null;

  /// The machines, who holds them by project and who waits for room (`GET /api/resources`); null when it can't be had.
  Future<ResourcesView?> resources() async => null;

  /// The text of one of that day's messages, when he touches its line.
  Future<MapBody?> companyMessage(String id) async => null;

  /// "השתקה" for 8 hours, a week or always, or its undo; kept on the server, the same on every device.
  Future<CommandResult> mute(String identityId, MuteFor duration) async =>  CommandResult.localized(785);
}
