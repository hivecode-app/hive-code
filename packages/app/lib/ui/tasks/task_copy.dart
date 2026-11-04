import '../../l10n/app_localizations.dart';
import '../../model/task_progress.dart';

String stageLabel(AppLocalizations l, TaskStage stage) => switch (stage) {
  TaskStage.proposal => l.progressProposal,
  TaskStage.development => l.progressDevelopment,
  TaskStage.review => l.progressReview,
  TaskStage.approval => l.progressApproval,
  TaskStage.released => l.progressReleased,
};
String stageIcon(TaskStage stage) => switch (stage) {
  TaskStage.proposal => 'lightbulb',
  TaskStage.development => 'build',
  TaskStage.review => 'fact_check',
  TaskStage.approval => 'front_hand',
  TaskStage.released => 'check_circle',
};
