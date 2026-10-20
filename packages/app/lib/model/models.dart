// Domain model of the app. Shapes follow docs/app/chat.md §8 (ChatItem) and the hq DTOs
// in packages/shared (InboxItemDTO, AskDTO, BoardEntry). Rendering never reads hq JSON directly.
import 'dart:typed_data';

enum Gender { f, m }

/// The owner's and the manager's names, as hq reads them from org.yaml (`/api/board` `names`). hq's own
/// texts are built from the same names (packages/shared/src/names.ts), so the app reads them back by them.
class CompanyNames {
  const CompanyNames({required this.ownerId, required this.owner, required this.ownerGender, required this.managerId, required this.manager, required this.managerGender});
  /// org.yaml `owner` ("ran"), not the protocol id `owner`.
  final String ownerId;
  final String owner;
  final Gender ownerGender;
  final String managerId;
  final String manager;
  final Gender managerGender;

  /// Before hq has said (and from an hq too old to say): the defaults of names.ts.
  static const fallback = CompanyNames(ownerId: 'owner', owner: 'בעל החברה', ownerGender: Gender.m, managerId: 'manager', manager: 'מנהל החברה', managerGender: Gender.m);

  static CompanyNames fromJson(Object? j) {
    if (j is! Map) return fallback;
    final o = j['owner'], m = j['manager'];
    String str(Object? p, String key, String or) => p is Map && p[key] is String && (p[key] as String).isNotEmpty ? p[key] as String : or;
    Gender gender(Object? p) => p is Map && p['gender'] == 'female' ? Gender.f : Gender.m;
    return CompanyNames(ownerId: str(o, 'id', fallback.ownerId), owner: str(o, 'name', fallback.owner), ownerGender: gender(o),
        managerId: str(m, 'id', fallback.managerId), manager: str(m, 'name', fallback.manager), managerGender: gender(m));
  }

  /// The owner's form of a word: `o('סגר', 'סגרה')`.
  String o(String male, String female) => ownerGender == Gender.f ? female : male;
  String m(String male, String female) => managerGender == Gender.f ? female : male;
}

/// The names in force: set from every board hq sends (hq_backend.dart).
CompanyNames companyNames = CompanyNames.fallback;

/// Derived status, always shown as icon + word (APP-SPEC §6.2).
enum WorkerStatus { free, working, waiting, blocked, stuck, restarting, resting, done }

class Team {
  const Team({required this.id, required this.name, required this.symbol, this.leadId, this.permanent = true});
  final String id;
  final String name;

  /// Material Symbols name (APP-SPEC §6.1 table), e.g. `local_shipping`.
  final String symbol;
  final String? leadId;
  final bool permanent;
}

/// hq itself as a sender: questions and notes from the server (accounts, pairing, failures).
/// Shown by name and with a symbol, never as a worker called "hq" (#55).
const kSystemId = 'hq';
const kSystem = Identity(id: kSystemId, name: 'המערכת', title: 'הודעה מהשרת', teamId: '');

/// "לדנה", and "למערכת" (the article drops after ל).
String toName(String name) => name == kSystem.name ? 'למערכת' : 'ל$name';

class Identity {
  const Identity({
    required this.id,
    required this.name,
    required this.title,
    required this.teamId,
    this.gender = Gender.m,
    this.temp = false,
    this.taskRef,
    String? short,
  }) : short = short ?? title;
  final String id;
  final String name;
  final String title;

  /// Short title for the narrow desktop list ("ניטור", "כספים").
  final String short;
  final String teamId;
  final Gender gender;

  /// Task-team worker or one-off helper: dashed monogram ring (APP-SPEC §6.1).
  final bool temp;

  /// e.g. `t3711` for a task-team worker ("עידו · מפתח · t3711").
  final String? taskRef;

  String get initial => name.characters.first;
}

extension on String {
  Iterable<String> get characters => runes.map(String.fromCharCode);
}

class Presence {
  const Presence({
    required this.status,
    this.activity,
    this.blockedOn,
    this.shift,
    this.shiftSince,
    this.contextPct,
    this.currentTask,
    this.queued = 0,
  });
  final WorkerStatus status;

  /// The task it is on now (hq `current_task`), for a standing worker on the org tab; null between tasks.
  final String? currentTask;

  /// Tasks handed to it that wait their turn (hq `queued`): a standing worker takes one at a time.
  final int queued;

  /// What the worker is doing right now, in words: "מריץ בדיקות", "כותבת".
  final String? activity;
  final String? blockedOn;
  final int? shift;
  final String? shiftSince;
  final int? contextPct;

  Presence copyWith({WorkerStatus? status, String? activity, bool clearActivity = false}) => Presence(
        status: status ?? this.status,
        activity: clearActivity ? null : (activity ?? this.activity),
        blockedOn: blockedOn,
        shift: shift,
        shiftSince: shiftSince,
        contextPct: contextPct,
        currentTask: currentTask,
        queued: queued,
      );
}

// ───────────────────────────── waiting for you (home) ─────────────────────────────

/// Sort order of APP-SPEC §4.2: urgent prod, blocking ask, GO, login, failure, soft ask.
enum WaitKind { urgentProd, blockingAsk, go, login, failure, softAsk }

enum WaitState { open, pending, answered, notNow }

class AskOption {
  const AskOption({required this.id, required this.label, String? shortLabel, this.primary = false})
      : shortLabel = shortLabel ?? label;
  final String id;
  final String label;

  /// Notification label, must keep the meaning ("ניסיון נוסף אחרי 24 ש'").
  final String shortLabel;
  final bool primary;
}

class WaitItem {
  WaitItem({
    required this.id,
    required this.kind,
    required this.from,
    required this.time,
    required this.kicker,
    required this.body,
    this.options = const [],
    this.askId,
    this.inboxId,
    this.domain,
    this.link,
    this.doneLine,
    this.state = WaitState.open,
    this.answerLine,
    this.createdAt,
    this.headline,
    this.ref,
    String? short,
  }) : short = short ?? kicker;

  /// The first line in his words ("עדכון לאפליקציה: תמונות בצ'אט"); [body] is the details under it.
  /// Null on items from before workers gave one: the body is all there is.
  final String? headline;

  /// hq's ref of the inbox item (the ask id, or the request_go op id): his answer message carries it.
  final String? ref;

  /// When it was raised (hq's created_at): where its card sits in the conversation.
  final DateTime? createdAt;

  /// One-line peek for the desktop context column.
  final String short;
  final String id;
  final WaitKind kind;
  final String from;

  /// Display time: "14:02" or "לפני 6 דק'".
  final String time;

  /// The small bold line: "חוסם · עובר ליואב בעוד 7 דק'", "GO לפרודקשן · לומו 1.1.20".
  final String kicker;

  /// Markup (see RichLine): backticks for mono LTR runs.
  final String body;

  /// One-tap answers (asks, GO). GO uses a primary option with id `go`.
  /// A GO's [askId] is `inbox:<id>`: it has no ask behind it, and is answered through the inbox item.
  final List<AskOption> options;
  final String? askId;
  final int? inboxId;
  final String? domain;

  /// The one-time tab handoff link from hq (B.9); "פתיחה" goes there. Null when hq gave none.
  final String? link;

  /// What the collapsed row says after delivery ("GO נשלח · דנה מתחילה פריסה").
  final String? doneLine;
  WaitState state;
  String? answerLine;

  bool get blocking => kind != WaitKind.softAsk;
}

class DecisionByManager {
  const DecisionByManager({required this.by, required this.text, required this.time});
  final String by;
  final String text;
  final String time;
}

class TeamActivity {
  const TeamActivity({required this.symbol, required this.team, required this.line, this.dormant = false});
  final String symbol;
  final String team;
  final String line;
  final bool dormant;
}

// ───────────────────────────── conversations ─────────────────────────────

class ConversationSummary {
  const ConversationSummary({
    required this.identityId,
    required this.lastLine,
    required this.time,
    this.lastIsMine = false,
    this.unread = 0,
    this.diffStat,
    this.extra,
    this.pinned = false,
    this.muted = false,
  });
  final String identityId;
  final String lastLine;
  final String time;

  /// The last line is from the worker (bold-ish) or the system (muted). Mockup: `.t2` vs `.t2.m`.
  final bool lastIsMine;
  final int unread;

  /// "+48 −11" when there are open code changes.
  final String? diffStat;

  /// Extra text after the status ("· יואב פתח לו עוזר").
  final String? extra;
  final bool pinned;

  /// Muted (hq `muted_until`): its count shows, but it alerts nothing and stays out of the total.
  final bool muted;

  ConversationSummary copyWith({int? unread, bool? muted}) => ConversationSummary(
        identityId: identityId,
        lastLine: lastLine,
        time: time,
        lastIsMine: lastIsMine,
        unread: unread ?? this.unread,
        diffStat: diffStat,
        extra: extra,
        pinned: pinned,
        muted: muted ?? this.muted,
      );
}

/// How long "השתקה" lasts (hq `POST /api/conversations/:id/mute {for}`); [off] is "ביטול השתקה".
enum MuteFor {
  hours8('8h', '8 שעות'),
  week('week', 'שבוע'),
  always('always', 'תמיד'),
  off('off', 'ביטול השתקה');

  const MuteFor(this.wire, this.label);
  final String wire;
  final String label;
}

// ───────────────────────────── chat items (chat.md §2, §8) ─────────────────────────────

enum Delivery { pendingConnection, queued, delivered, read, handled, failed }

enum Priority { now, next, later }

enum Outcome { ok, error, interrupted, running }

sealed class ChatItem {
  ChatItem({required this.id, required this.ts, this.seq = 0});
  final String id;
  final DateTime ts;
  int seq;
}

class UserMsg extends ChatItem {
  UserMsg({
    required super.id,
    required super.ts,
    required this.text,
    this.delivery = Delivery.delivered,
    this.priority = Priority.next,
    this.replyTo,
    this.attachments = const [],
    super.seq,
  });
  String text;
  Delivery delivery;
  Priority priority;
  final Quote? replyTo;

  /// Images sent with the message. Replaced by the uploaded ones (with hq ids) once they are up.
  List<Attachment> attachments;
}

class Quote {
  const Quote({required this.author, required this.text, this.itemId, this.askId, this.go = false});

  /// Answering a GO request (its askId is `inbox:<id>`).
  final bool go;
  final String author;
  final String text;
  final String? itemId;

  /// Quoting a question: the reply is its answer (POST /api/asks/:id/answer), not a new message (#55).
  final String? askId;
}

class Attachment {
  const Attachment({required this.name, required this.bytes, required this.mime, this.id, this.data});
  final String name;
  final int bytes;
  final String mime;

  /// hq's upload id (`GET /api/uploads/:id`); null until the image is uploaded.
  final String? id;

  /// The bytes on this device: the preview before sending, and the bubble without a round trip.
  final Uint8List? data;

  bool get isImage => mime.startsWith('image/');

  Attachment uploaded(String id) => Attachment(name: name, bytes: bytes, mime: mime, id: id, data: data);
}

/// The formats hq takes (packages/hq/src/uploads.ts), and what a keyboard may hand over.
const kImageMimes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/// hq's limit (uploads.ts UPLOAD_MAX_BYTES).
const maxImageBytes = 25 * 1024 * 1024;

/// The image type by its first bytes, the way hq decides; null when it is not one hq takes.
String? imageMime(Uint8List b) {
  bool at(int i, List<int> sig) => b.length >= i + sig.length && Iterable<int>.generate(sig.length).every((k) => b[i + k] == sig[k]);
  if (at(0, const [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (at(0, const [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (at(0, 'GIF87a'.codeUnits) || at(0, 'GIF89a'.codeUnits)) return 'image/gif';
  if (at(0, 'RIFF'.codeUnits) && at(8, 'WEBP'.codeUnits)) return 'image/webp';
  return null;
}

class TextMsg extends ChatItem {
  TextMsg({required super.id, required super.ts, required this.text, this.streaming = false, this.author, this.attachments = const [], super.seq});

  /// Markdown (subset): paragraphs, lists, **bold**, `code`, ``` blocks ```, > quotes.
  String text;
  bool streaming;

  /// Images the worker sent with the message (hq ids). Added to a streamed bubble when its stored copy lands.
  List<Attachment> attachments;

  /// Set only when another participant writes (e.g. יואב joins).
  final String? author;
}

class ToolLine {
  const ToolLine({required this.icon, required this.label, this.trail, this.outcome = Outcome.ok, this.name});
  final String icon;

  /// LTR detail: a path, a search, a command.
  final String label;

  /// Small trailing info: "1–220", "7".
  final String? trail;
  final Outcome outcome;
  final String? name;
}

class ToolGroup extends ChatItem {
  ToolGroup({required super.id, required super.ts, required this.summary, required this.tools, this.outcome = Outcome.ok, this.liveLabel, this.elapsed, super.seq});

  /// The Hebrew sentence (built by hq's summarizeTools; locally until hq ships it).
  String summary;
  final List<ToolLine> tools;
  Outcome outcome;

  /// While running, the live tool in bold: "מריץ בדיקות".
  String? liveLabel;
  String? elapsed;
}

enum DiffLineKind { ctx, add, del }

class DiffLine {
  const DiffLine(this.kind, this.no, this.text, {this.marks = const []});
  final DiffLineKind kind;
  final int no;
  final String text;

  /// Changed words inside the line, shown bold + underlined.
  final List<String> marks;
}

class DiffHunk {
  const DiffHunk(this.header, this.lines);
  final String header;
  final List<DiffLine> lines;
}

class DiffFile {
  const DiffFile({required this.path, required this.add, required this.del, this.hunks = const []});
  final String path;
  final int add;
  final int del;
  final List<DiffHunk> hunks;
}

class DiffCard extends ChatItem {
  DiffCard({required super.id, required super.ts, required this.files, this.note, this.prRef, super.seq});
  final List<DiffFile> files;
  final String? note;
  final String? prRef;
}

class TestFailure {
  const TestFailure(this.name, this.location, this.why);
  final String name;
  final String location;
  final String why;
}

class TestResultCard extends ChatItem {
  TestResultCard({required super.id, required super.ts, required this.passed, this.failed = 0, this.skipped = 0, this.seconds, this.failures = const [], super.seq});
  final int passed;
  final int failed;
  final int skipped;
  final int? seconds;
  final List<TestFailure> failures;
}

class TerminalCard extends ChatItem {
  TerminalCard({required super.id, required super.ts, required this.command, required this.tail, this.totalLines, this.exitCode = 0, this.footer, super.seq});
  final String command;
  final List<String> tail;
  final int? totalLines;
  final int exitCode;

  /// "בדיקות · 144 עברו" under the output.
  final String? footer;
}

enum PrState { open, merged, closed }

enum Check { none, running, ok, failed }

class PrCard extends ChatItem {
  PrCard({required super.id, required super.ts, required this.number, required this.title, this.state = PrState.open, this.ci = Check.none, this.review = Check.none, this.add = 0, this.del = 0, this.files = 0, this.fileList = const [], super.seq});
  final int number;
  final String title;
  PrState state;
  Check ci;
  Check review;
  final int add;
  final int del;
  final int files;

  /// Per-file stats for the desktop context column.
  final List<DiffFile> fileList;
}

enum AskState { open, pending, answered, decidedByManager, expired }

class AskCard extends ChatItem {
  AskCard({
    required super.id,
    required super.ts,
    required this.from,
    required this.question,
    required this.options,
    this.headline,
    this.blocking = true,
    this.escalation,
    this.state = AskState.open,
    this.answer,
    this.askId,
    String? ref,
    super.seq,
  }) : ref = ref ?? askId;
  final String from;

  /// What his answer message points at (ref): the ask id, or the request_go op id of a GO.
  final String? ref;

  /// The first line, in his words. The [question] folds under it as the details. Null: the question is all.
  final String? headline;
  final String question;
  final List<AskOption> options;
  final bool blocking;

  /// "עוברת ליואב בעוד 7 דק'".
  final String? escalation;
  AskState state;
  String? answer;
  final String? askId;
}

class GoCard extends AskCard {
  GoCard({
    required super.id,
    required super.ts,
    required super.from,
    super.headline,
    required String details,
    super.state,
    super.answer,
    super.askId,
    super.ref,
    super.seq,
  }) : super(question: details, options: const [
          AskOption(id: 'go', label: 'GO', primary: true),
          AskOption(id: 'not_now', label: 'לא עכשיו'),
        ]);
}

enum PermissionState { open, allowed, denied, allowedForTask }

class PermissionCard extends ChatItem {
  PermissionCard({required super.id, required super.ts, required this.from, required this.command, this.state = PermissionState.open, super.seq});
  final String from;
  final String command;
  PermissionState state;
}

class DecidedCard extends ChatItem {
  DecidedCard({required super.id, required super.ts, required this.by, required this.text, required this.time, super.seq});
  final String by;
  final String text;
  final String time;
}

class FileMsg extends ChatItem {
  FileMsg({required super.id, required super.ts, required this.name, required this.bytes, required this.mime, super.seq});
  final String name;
  final int bytes;
  final String mime;
}

class ShiftMarker extends ChatItem {
  ShiftMarker({required super.id, required super.ts, required this.shift, required this.from, super.seq});
  final int shift;
  final int from;
}

class EventLine extends ChatItem {
  EventLine({required super.id, required super.ts, required this.text, this.icon, this.strong = false, this.between = const [], super.seq});
  final String text;
  final String? icon;

  /// A message between two workers: both identities. In one's conversation, a tap opens the other's.
  final List<String> between;

  /// "2 הודעות חדשות" divider is strong.
  final bool strong;
}

class HandoffCard extends ChatItem {
  HandoffCard({required super.id, required super.ts, required this.domain, required this.expires, this.done = false, super.seq});
  final String domain;
  final String expires;
  bool done;
}

class ErrorLine extends ChatItem {
  ErrorLine({required super.id, required super.ts, required this.text, super.seq});
  final String text;
}

class UnknownItem extends ChatItem {
  UnknownItem({required super.id, required super.ts, required this.kind, super.seq});
  final String kind;
}

/// What the worker is doing at the end of the list (chat.md §2.2).
enum LivePhase { idle, starting, thinking, writing, tool, compacting, stopped }

class LiveState {
  const LiveState({this.phase = LivePhase.idle, this.label, this.seconds, this.runningCommand, this.stoppedAt});
  final LivePhase phase;
  final String? label;
  final int? seconds;

  /// A Bash command in flight: stop asks first (chat.md §3).
  final String? runningCommand;
  final String? stoppedAt;
  bool get busy => phase != LivePhase.idle && phase != LivePhase.stopped;
}

class Conversation {
  Conversation({required this.identityId, required this.items, this.live = const LiveState(), this.draft = ''});
  final String identityId;
  final List<ChatItem> items;
  LiveState live;
  String draft;
}

// ───────────────────────────── board / ticket ─────────────────────────────

enum TicketGroup { waiting, attention, working, doneToday, queued }

class Ticket {
  const Ticket({
    required this.number,
    required this.title,
    required this.project,
    required this.projectName,
    required this.group,
    required this.assignee,
    this.sub,
    required this.status,
    this.endLine,
    this.diffStat,
    this.assigneeId,
    this.startedAt,
    this.doneAt,
    this.summary,
    this.openedBy,
  });
  final String number;
  final String title;
  final String project;
  final String projectName;
  final TicketGroup group;
  final String assignee;

  /// After the assignee: "GO לפרודקשן", "מחכה לגישה ל-k8s".
  final String? sub;
  final WorkerStatus status;
  final String? endLine;
  final String? diffStat;

  /// The worker on it (a task worker too); null while it waits in the queue.
  final String? assigneeId;
  final DateTime? startedAt;

  /// When it finished; null while it is open.
  final DateTime? doneAt;

  /// What it did, one line in his words (hq `tasks.summary`, written at status done / close_team).
  final String? summary;

  /// Who opened it (`opened-by:` label): its lead on the main screen when it has no project.
  final String? openedBy;

  /// The line "מה הסתיים" shows: the summary, or the title without its area prefix.
  String get doneLine => summary?.trim().isNotEmpty == true ? summary!.trim() : plainTitle(title);
}

/// "מה לבדוק" (hq `awaiting`, #108): a finished task that still waits on him. `deploy` = merged, waits for a GO
/// or a deploy (a deploy that includes it clears it); `check` = live, he has to check something himself.
enum AwaitingKind { deploy, check }

class AwaitingTask {
  const AwaitingTask({required this.id, required this.kind, required this.title, required this.at, this.project = '', this.summary, this.note, this.identity, this.pr});
  final int id;
  final AwaitingKind kind;
  final String title;
  final String project;

  /// What it did, in his words (`tasks.summary`); the title when none.
  final String? summary;

  /// One line in his words: what waits, or what to check (`awaiting_note`).
  final String? note;

  /// The worker who did it: its conversation is where a tap goes.
  final String? identity;
  final String? pr;
  final DateTime at;

  String get line => summary?.trim().isNotEmpty == true ? summary!.trim() : plainTitle(title);

  /// From `/api/board`'s `awaiting`; null for a kind this app does not know.
  static AwaitingTask? fromHq(Map<String, dynamic> j) {
    final kind = AwaitingKind.values.asNameMap()[j['awaiting']];
    if (kind == null || j['id'] is! num) return null;
    return AwaitingTask(
      id: (j['id'] as num).toInt(),
      kind: kind,
      title: j['title'] as String? ?? '',
      project: j['project'] as String? ?? '',
      summary: j['summary'] as String?,
      note: j['awaiting_note'] as String?,
      identity: j['identity'] as String?,
      pr: j['pr'] as String?,
      at: DateTime.fromMillisecondsSinceEpoch(((j['awaiting_at'] as num?) ?? 0).toInt()),
    );
  }
}

/// "ביקשת" (hq `asked`, #118): a request of his to a worker that still has no answer he read. `open` = no
/// answer yet; `answered` = the worker answered and he hasn't read it (hq drops it once he does).
enum AskedState { open, answered }

/// The worker's answer to a request: its message id, its start (hq cuts it at 300), when.
class AskedReply {
  const AskedReply({required this.id, required this.body, required this.at});
  final String id;
  final String body;
  final DateTime at;
}

class AskedRequest {
  const AskedRequest({required this.id, required this.identity, required this.body, required this.at, this.count = 1, this.state = AskedState.open, this.reply});

  /// His message id (the first of the ones this row stands for).
  final String id;

  /// The worker he asked.
  final String identity;

  /// His message, cut at 300.
  final String body;
  final DateTime at;

  /// How many of his messages to the worker this row stands for.
  final int count;
  final AskedState state;
  final AskedReply? reply;

  /// From `/api/board`'s `asked`; null for a state this app does not know or a row without its ids.
  static AskedRequest? fromHq(Map<String, dynamic> j) {
    final state = AskedState.values.asNameMap()[j['state']];
    if (state == null || j['id'] is! String || j['identity'] is! String) return null;
    final r = j['reply'];
    return AskedRequest(
      id: j['id'] as String,
      identity: j['identity'] as String,
      body: j['body'] as String? ?? '',
      at: DateTime.fromMillisecondsSinceEpoch(((j['created_at'] as num?) ?? 0).toInt()),
      count: ((j['count'] as num?) ?? 1).toInt().clamp(1, 1 << 20),
      state: state,
      reply: r is Map && r['id'] is String
          ? AskedReply(id: r['id'] as String, body: r['body'] as String? ?? '', at: DateTime.fromMillisecondsSinceEpoch(((r['created_at'] as num?) ?? 0).toInt()))
          : null,
    );
  }
}

/// A project from org.yaml (`projects:`) with its charter's status; the board's filter chips.
class ProjectInfo {
  const ProjectInfo({required this.id, required this.active, String? name, this.teamId}) : name = name ?? id;
  final String id;
  final String name;

  /// The project's standing team (org.yaml `projects[].team`): its lead is the project's team lead.
  final String? teamId;

  /// The charter says `active`. A dormant project has no workers yet (it moves to the company later).
  final bool active;
}

class TimelineEntry {
  const TimelineEntry({required this.icon, required this.text, required this.time, this.link, this.filled = false});
  final String icon;
  final String text;
  final String time;
  final String? link;
  final bool filled;
}

class TicketDetail {
  const TicketDetail({required this.ticket, required this.statusLine, required this.pairs, required this.timeline});
  final Ticket ticket;
  final String statusLine;
  final List<(String, String)> pairs;
  final List<TimelineEntry> timeline;
}

// ───────────────────────────── org / automations ─────────────────────────────

class OrgMember {
  const OrgMember({required this.identityId, required this.line, this.group, this.sub = false});
  final String identityId;

  /// "מנכ"לית לומו · משמרת 7".
  final String line;

  /// Group header before this member: "צוות משימה t3711 · תשלומים נכשלים".
  final String? group;
  final bool sub;
}

class OrgTeam {
  const OrgTeam({required this.teamId, required this.line, required this.statusIcon, required this.statusWord, this.bold = false, this.members = const [], this.canWake = false});
  final String teamId;
  final String line;
  final String statusIcon;
  final String statusWord;
  final bool bold;
  final List<OrgMember> members;
  final bool canWake;
}

class Capacity {
  const Capacity(this.host, this.value, {this.off = false, this.mono = true});
  final String host;
  final String value;
  final bool off;
  final bool mono;
}

class Automation {
  Automation({required this.key, required this.team, required this.sentence, required this.meta, this.enabled = true});
  final String key;
  final String team;
  final String sentence;
  String meta;
  bool enabled;
  String? prevMeta;
}

// ───────────────────────────── system status (APP-SPEC §4.1) ─────────────────────────────

enum LinkState { demo, connecting, offline, online, reconnected }

class SystemStatus {
  const SystemStatus(this.state, {this.since, this.updated = 0});
  final LinkState state;
  final String? since;
  final int updated;
}

/// A task title as one line for him: without the area prefix ("אפליקציה: ", "hq: ") and the issue number.
String plainTitle(String title) {
  // PR and ticket numbers are ours, not his (status summary rules): "סיום PR #43: X" reads "סיום: X".
  var t = title.trim().replaceAll(RegExp(r'\s*\(#\d+\)'), '').replaceAll(RegExp(r'\s*\bPR\s*#\d+'), '').replaceFirst(RegExp(r'^#\d+\s+'), '').replaceAll(RegExp(r'\s+#\d+\b'), '');
  final m = RegExp(r'^([^:]{1,14}):\s+').firstMatch(t);
  if (m != null) t = t.substring(m.end);
  return t.isEmpty ? title : t;
}
