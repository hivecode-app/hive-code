// "מי עובד עכשיו": a strip of faces, each with its name and what it is on. A tap opens the conversation.
import 'package:flutter/material.dart';

import '../../data/store.dart';
import '../../theme/tokens.dart';
import '../common.dart';
import '../nav.dart';
import 'data.dart';
import 'parts.dart';

class PeopleBlock extends StatelessWidget {
  const PeopleBlock({super.key, required this.data});
  final PeopleData data;

  @override
  Widget build(BuildContext context) {
    final p = context.p;
    final d = StoreScope.of(context).data;
    if (data.people.isEmpty || d == null) return const SizedBox.shrink();
    return Semantics(
      container: true,
      label: 'מי עובד עכשיו',
      explicitChildNodes: true,
      // Each worker gets the same width, two lines and an ellipsis inside it. When they all fit, they share the
      // card's width; when not, the strip scrolls, with room at both ends so nothing is cut at the card's edge.
      child: LayoutBuilder(
        builder: (context, c) {
          const minW = 88.0;
          final room = c.maxWidth - 16;
          final fits = data.people.length * minW <= room;
          final w = fits ? room / data.people.length : 112.0;
          final items = [
            for (final x in data.people)
              Semantics(
                button: true,
                label: '${d.who(x.id).name}, ${x.text}${x.since == null ? '' : ', מ-${hm(x.since!)}'}',
                excludeSemantics: true,
                child: InkWell(
                  borderRadius: BorderRadius.circular(12),
                  onTap: () => d.canChat(x.id) ? Nav.chat(context, x.id) : null,
                  child: SizedBox(
                    width: w,
                    child: Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Monogram.of(d, x.id, size: AvSize.sm, ring: p.surface),
                          const SizedBox(height: 8),
                          Row(
                            children: [
                              Ic(statusIcon(x.status), size: 14, fill: true, color: p.text),
                              const SizedBox(width: 3),
                              Expanded(
                                child: Text(
                                  d.who(x.id).name,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: T.small.copyWith(color: p.text, fontWeight: FontWeight.w500),
                                ),
                              ),
                            ],
                          ),
                          const SizedBox(height: 2),
                          Rich(x.text, auto: true, maxLines: 2, style: T.meta.copyWith(color: p.text2)),
                          if (x.since != null)
                            Text(
                              'מ-${hm(x.since!)}',
                              style: T.meta.copyWith(color: p.text3, fontFeatures: kTabular),
                            ),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
          ];
          return fits
              ? Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 12),
                  child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: items),
                )
              : SingleChildScrollView(
                  scrollDirection: Axis.horizontal,
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 12),
                  child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: items),
                );
        },
      ),
    );
  }
}
