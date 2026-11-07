import 'package:flutter/material.dart';

import '../../l10n/app_localizations.dart';
import '../../model/task_progress.dart';
import '../../theme/tokens.dart';
import '../common.dart';
import 'task_copy.dart';

/// Where the task stands, read-only: five segments, the current one marked, the ones behind it filled.
class TaskTimeline extends StatelessWidget {
  const TaskTimeline({super.key, required this.current});
  final TaskStage? current;
  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context), p = context.p;
    String status(TaskStage s) => current == null
        ? l.progressUnknown
        : s.index < current!.index
        ? l.progressStageDone
        : s == current
        ? l.progressStageCurrent
        : l.progressStagePending;
    if (MediaQuery.textScalerOf(context).scale(1) >= 1.5) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (current == null)
            StatusWord(icon: 'progress_activity', word: l.progressUnknown, bold: true, size: 16)
          else ...[
            StatusWord(icon: stageIcon(current!), word: stageLabel(l, current!), bold: true, size: 16),
            const SizedBox(height: 8),
            Text(l.progressStageCount(current!.index + 1, TaskStage.values.length), style: T.meta.copyWith(color: p.text2)),
          ],
        ],
      );
    }
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (final s in TaskStage.values)
          Expanded(
            child: Padding(
              padding: EdgeInsetsDirectional.only(end: s == TaskStage.values.last ? 0 : 8),
              child: Semantics(
                key: ValueKey('stage-${s.name}'),
                label: stageLabel(l, s),
                value: status(s),
                child: ExcludeSemantics(
                  child: Column(
                    children: [
                      Container(
                        height: s == current ? 3 : 2,
                        color: current != null && s.index <= current!.index ? p.text : p.line,
                      ),
                      const SizedBox(height: 12),
                      // A past stage carries a check: done is a mark, not only a color.
                      Row(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          Ic(stageIcon(s), size: 20, color: s == current ? p.text : p.text2, fill: s == current && s == TaskStage.approval),
                          if (current != null && s.index < current!.index) ...[
                            const SizedBox(width: 4),
                            Ic('check', size: 12, color: p.text2),
                          ],
                        ],
                      ),
                      const SizedBox(height: 6),
                      Text(
                        stageLabel(l, s),
                        textAlign: TextAlign.center,
                        // One line: a word is not broken in the middle ("In develop / ment").
                        maxLines: 1,
                        softWrap: false,
                        overflow: TextOverflow.ellipsis,
                        style: T.small.copyWith(
                          color: s == current ? p.text : p.text2,
                          fontWeight: s == current ? FontWeight.w600 : FontWeight.w400,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
      ],
    );
  }
}
