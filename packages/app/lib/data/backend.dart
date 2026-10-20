// The one interface between the UI and a company backend.
// FakeBackend (mockup content) and HqBackend (packages/hq HTTP+WS) both implement it;
// lib/data/backend_select.dart picks one, and that is the only line that changes.
import 'package:flutter/foundation.dart';

import '../model/models.dart';

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
  });

  final Map<String, Team> teams;
  final Map<String, Identity> identities;
  final Map<String, Presence> presence;
  final List<WaitItem> waiting;
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

  int get waitingCount => waiting.where((w) => w.state == WaitState.open || w.state == WaitState.pending).length;

  Identity who(String id) => identities[id] ?? (id == kSystemId ? kSystem : Identity(id: id, name: id, title: '', teamId: ''));

  /// A worker the owner can talk to. hq itself (the accounts manager, pairing, failures) is not:
  /// it has no conversation, and a message to it reaches no one (#55).
  bool canChat(String id) => id != kSystemId;
  Team? teamOf(String identityId) => teams[identities[identityId]?.teamId];
}

/// Result of a command that reaches the server. Failure text is one plain sentence (design-taste §7).
class CommandResult {
  const CommandResult.ok() : ok = true, error = null;
  const CommandResult.fail(this.error) : ok = false;
  final bool ok;
  final String? error;
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
  CompanyData? get data;
  SystemStatus get status;

  /// Short label shown in settings: "הדגמה" or the server host.
  String get label;

  Future<void> start();

  Future<CommandResult> answerAsk(String askId, AskOption option, {String? from});
  /// Free text (and images, [UserMsg.attachments] style) as the answer to a question.
  Future<CommandResult> freeAnswer(String askId, String text, {List<Attachment> attachments = const []});
  Future<CommandResult> go(WaitItem item);
  Future<CommandResult> notNow(WaitItem item);
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
  Future<CommandResult> pinAccount(String? name) async => const CommandResult.fail('אין חשבונות בהדגמה.');

  /// Called when a conversation opens (hq: replay events for that identity).
  Future<void> openConversation(String identityId) async {}

  /// A chat screen for [identityId] is now on screen (pushed, or switched to on desktop). Paired
  /// with [closeConversation]; the most recent one still on screen is the open conversation.
  void showConversation(String identityId) {}

  /// That screen left: what arrives for it from now on is not "read" (unless another screen for
  /// the same worker is still showing).
  void closeConversation(String identityId) {}
}
