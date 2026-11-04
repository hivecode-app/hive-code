import 'package:flutter/material.dart';

import '../../l10n/app_localizations.dart';
import '../../model/task_progress.dart';
import '../../theme/tokens.dart';
import '../common.dart';
import 'task_copy.dart';

/// Progress is read-only. Touching a segment selects the activity to read, never a new task state.
class TaskTimeline extends StatelessWidget {
  const TaskTimeline({
    super.key,
    required this.current,
    required this.selected,
    required this.onSelect,
  });
  final TaskStage? current, selected;
  final ValueChanged<TaskStage> onSelect;
  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context), p = context.p;
    if (MediaQuery.textScalerOf(context).scale(1) >= 1.5) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (current != null) ...[
            StatusWord(
              icon: stageIcon(current!),
              word: stageLabel(l, current!),
              bold: true,
              size: 16,
            ),
            const SizedBox(height: 8),
            Text(
              l.progressStageCount(current!.index + 1, TaskStage.values.length),
              style: T.meta.copyWith(color: p.text2),
            ),
          ],
          TextButton.icon(
            key: const Key('choose-stage-activity'),
            icon: const Ic('history'),
            label: Text(l.progressViewActivity),
            onPressed: () => showModalBottomSheet<void>(
              context: context,
              showDragHandle: true,
              builder: (sheet) => SafeArea(
                child: ListView(
                  shrinkWrap: true,
                  children: [
                    for (final s in TaskStage.values)
                      ListTile(
                        key: ValueKey('stage-${s.name}'),
                        leading: Ic(stageIcon(s)),
                        title: Text(stageLabel(l, s)),
                        onTap: () {
                          Navigator.pop(sheet);
                          onSelect(s);
                        },
                      ),
                  ],
                ),
              ),
            ),
          ),
        ],
      );
    }
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (final s in TaskStage.values)
          Expanded(
            child: Padding(
              padding: EdgeInsetsDirectional.only(
                end: s == TaskStage.values.last ? 0 : 8,
              ),
              child: Semantics(
                selected: s == selected,
                label: l.progressStageActivity(stageLabel(l, s)),
                child: InkWell(
                  key: ValueKey('stage-${s.name}'),
                  onTap: () => onSelect(s),
                  child: ConstrainedBox(
                    constraints: const BoxConstraints(minHeight: 80),
                    child: Column(
                      children: [
                        Container(
                          height: s == current ? 3 : 2,
                          color: current != null && s.index <= current!.index
                              ? p.text
                              : p.line,
                        ),
                        const SizedBox(height: 12),
                        Ic(stageIcon(s), size: 20),
                        const SizedBox(height: 6),
                        Text(
                          stageLabel(l, s),
                          textAlign: TextAlign.center,
                          style: T.small.copyWith(
                            color: p.text,
                            fontWeight: s == current
                                ? FontWeight.w600
                                : FontWeight.w400,
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
      ],
    );
  }
}
