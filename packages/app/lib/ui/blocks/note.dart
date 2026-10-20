// A line from whoever composes the home, in her words ("שמתי לב ש…"), with a symbol and her name.
import 'package:flutter/material.dart';

import '../../data/store.dart';
import '../../theme/tokens.dart';
import '../common.dart';
import 'data.dart';

class NoteBlock extends StatelessWidget {
  const NoteBlock({super.key, required this.data});
  final NoteData data;

  @override
  Widget build(BuildContext context) {
    final p = context.p;
    final d = StoreScope.of(context).data;
    final from = data.from == null ? null : d?.who(data.from!).name ?? data.from;
    return Semantics(
      label: [data.text, ?from].join(', '),
      excludeSemantics: true,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Padding(padding: const EdgeInsets.only(top: 1), child: Ic(data.icon ?? 'lightbulb', size: 20, color: p.text)),
          const SizedBox(width: 10),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Rich(data.text, auto: true, style: T.row2.copyWith(color: p.text)),
              if (from != null) Padding(padding: const EdgeInsets.only(top: 2), child: Text(from, style: T.meta.copyWith(color: p.text2))),
            ]),
          ),
        ]),
      ),
    );
  }
}
