// What a worker did or does leads to a conversation (docs/app/links.md): a task to the worker on it, or, once a
// task worker finished it, to whoever opened it, the one who owns the effort. One rule, one widget, every screen.
import 'package:flutter/material.dart';

import '../data/backend.dart';
import '../data/store.dart';
import '../model/models.dart';
import 'nav.dart';

/// The conversation a task leads to: [worker] while it is theirs to talk about; a task worker who finished
/// hands it to [openedBy]; nobody on it yet, to [openedBy] too. Null when there is no one to talk to.
String? chatTargetOf(CompanyData d, {String? worker, String? openedBy, bool done = false}) {
  bool ok(String? id) => id != null && id.isNotEmpty && d.canChat(id) && d.identities.containsKey(id);
  final handedOver = worker != null && done && d.who(worker).temp;
  if (ok(worker) && !handedOver) return worker;
  if (ok(openedBy)) return openedBy;
  return ok(worker) ? worker : null;
}

/// The task hq knows by [id] (`t<id>` on the board), if the board has it.
Ticket? ticketOf(CompanyData d, int id) => d.tickets.where((t) => t.number == 't$id').firstOrNull;

/// [chatTargetOf] for a task on the board.
String? chatTargetOfTicket(CompanyData d, Ticket t) => chatTargetOf(d, worker: t.assigneeId, openedBy: t.openedBy, done: t.doneAt != null);

/// A row of its own on a list (APP-SPEC §7.4: touch surfaces of 48dp).
const kLinkRow = 48.0;

/// A line inside a card or row that opens something else: lines stacked under each other each lead to another
/// worker, and a slight miss must not open the wrong one.
const kLinkLine = 40.0;

/// A line that stands for a worker's work: a tap opens [identity]'s conversation. It looks like the lines around
/// it (no link color, no underline): the ripple and the screen reader's hint say it is one. Its target is the
/// line with its padding, at least [minHeight] ([kLinkRow] or [kLinkLine]), the line centered in it.
/// With no [identity] it is the bare [child], read as [label].
class EntityLink extends StatelessWidget {
  const EntityLink({super.key, required this.identity, required this.child, this.label, this.minHeight = 0, this.borderRadius});

  /// The conversation it opens; null: nothing to open.
  final String? identity;
  final Widget child;

  /// What a screen reader reads for it; the child's own text when null.
  final String? label;
  final double minHeight;
  final BorderRadius? borderRadius;

  @override
  Widget build(BuildContext context) {
    final id = identity;
    if (id == null) return label == null ? child : Semantics(label: label, excludeSemantics: true, child: child);
    final d = StoreScope.of(context).data;
    final name = d?.who(id).name ?? id;
    return Semantics(
      button: true,
      label: label,
      hint: 'שיחה עם $name',
      excludeSemantics: label != null,
      child: InkWell(
        borderRadius: borderRadius,
        onTap: () => Nav.chat(context, id),
        child: ConstrainedBox(
          constraints: BoxConstraints(minHeight: minHeight),
          child: Align(alignment: AlignmentDirectional.centerStart, heightFactor: 1, child: child),
        ),
      ),
    );
  }
}
