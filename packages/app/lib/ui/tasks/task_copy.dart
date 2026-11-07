import '../../data/backend.dart' show CompanyData;
import '../../l10n/app_localizations.dart';
import '../../model/task_progress.dart';

String stageLabel(AppLocalizations l, TaskStage stage) => switch (stage) {
  TaskStage.proposal => l.progressProposal,
  TaskStage.development => l.progressDevelopment,
  TaskStage.review => l.progressReview,
  TaskStage.approval => l.progressApproval,
  TaskStage.released => l.progressReleased,
};
/// A group's heading: a list of tasks, not one.
String groupLabel(AppLocalizations l, TaskStage stage) => switch (stage) {
  TaskStage.proposal => l.progressProposals,
  TaskStage.released => l.progressReleasedWeek,
  _ => stageLabel(l, stage),
};
String stageIcon(TaskStage stage) => switch (stage) {
  TaskStage.proposal => 'lightbulb',
  TaskStage.development => 'play_arrow',
  TaskStage.review => 'rate_review',
  TaskStage.approval => 'front_hand',
  TaskStage.released => 'check_circle',
};

/// The project's name as he calls it (org.yaml), not its slug.
String projectName(CompanyData d, String? project) => project == null
    ? ''
    : d.projects.where((p) => p.id == project).firstOrNull?.name ?? d.teams[project]?.name ?? project;

/// The project's tone, for its dot: the tone of its standing team.
String? projectTone(CompanyData d, String? project) {
  if (project == null) return null;
  final team = d.projects.where((p) => p.id == project).firstOrNull?.teamId ?? project;
  return d.teams[team]?.tone;
}

/// "פרויקט · עובד": who is on it, where. A proposal says whose idea it is instead.
String taskWhere(CompanyData d, AppLocalizations l, TaskProgress t) => [
  if (t.project != null) projectName(d, t.project),
  if (t.state == 'proposal' && t.openedBy != null)
    l.progressProposalBy(d.who(t.openedBy!).name)
  else if (t.worker != null)
    d.who(t.worker!).name,
].join(' · ');

/// The one fact about where it stands now, in his words: what waits on him first, then the PR, then what the worker does.
String taskDetail(CompanyData d, AppLocalizations l, TaskProgress t) {
  if (t.requests.any((r) => r.kind == 'go')) return l.progressDetailGo;
  if (t.requests.any((r) => r.kind == 'ask')) return l.progressDetailAsk;
  switch (t.awaiting) {
    case 'deploy':
      return l.progressDetailDeploy;
    case 'verify':
      return l.progressDetailVerify;
    case 'check':
      return l.progressDetailCheck;
  }
  if (t.outcome != null || t.state == 'proposal') return '';
  if (t.state == 'queued') return l.progressDetailQueued;
  if (t.workerStatus == 'stuck') return l.stuck;
  final open = t.prs.where((p) => p.open && !p.stale).toList();
  if (open.isNotEmpty) {
    if (open.any((p) => p.review == 'changes')) return l.progressDetailFixes;
    if (open.any((p) => p.ci == 'failed')) return l.progressCiFailed;
    if (open.any((p) => p.review == 'pending')) return l.progressDetailInReview;
    if (open.any((p) => p.ci != 'passed')) return l.progressDetailChecksRunning;
    return l.progressDetailApproved;
  }
  // What the worker does now; its task's own title when it says nothing more (the row already shows it).
  final doing = t.worker == null ? null : d.presence[t.worker!]?.activity?.trim();
  return doing == null || doing.isEmpty || doing == t.title.trim() || t.title.contains(doing) ? '' : doing;
}
