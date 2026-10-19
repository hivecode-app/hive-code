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
  bool focus;

  /// "לילה · 3/3 משבצות · 7 בתור · 2 דולגו" when night mode runs.
  String? night;

  int get waitingCount => waiting.where((w) => w.state == WaitState.open || w.state == WaitState.pending).length;

  Identity who(String id) => identities[id] ?? Identity(id: id, name: id, title: '', teamId: '');
  Team? teamOf(String identityId) => teams[identities[identityId]?.teamId];
}

/// Result of a command that reaches the server. Failure text is one plain sentence (design-taste §7).
class CommandResult {
  const CommandResult.ok() : ok = true, error = null;
  const CommandResult.fail(this.error) : ok = false;
  final bool ok;
  final String? error;
}

abstract class Backend extends ChangeNotifier {
  CompanyData? get data;
  SystemStatus get status;

  /// Short label shown in settings: "הדגמה" or the server host.
  String get label;

  Future<void> start();

  Future<CommandResult> answerAsk(String askId, AskOption option, {String? from});
  Future<CommandResult> freeAnswer(String askId, String text);
  Future<CommandResult> go(WaitItem item);
  Future<CommandResult> notNow(WaitItem item);
  Future<CommandResult> retry(WaitItem item);

  /// Sends a message; the backend updates [UserMsg.delivery] as acks come in.
  Future<CommandResult> send(String identityId, UserMsg msg);
  Future<CommandResult> retract(String identityId, String msgId);
  Future<CommandResult> stop(String identityId);
  Future<CommandResult> setAutomation(String key, bool enabled);
  Future<CommandResult> setFocus(bool on);
  Future<CommandResult> wake(String teamId);
  Future<CommandResult> handoffDone(WaitItem item);

  /// Called when a conversation opens (hq: replay events for that identity).
  Future<void> openConversation(String identityId) async {}
}
