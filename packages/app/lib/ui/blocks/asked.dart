// "ביקשת" (#118) as a block of its own (the home recipe's `asked {messages[]}`): a row per request of his to a
// worker that has no answer he read. Open: "מחכה לעידו · לפני 12 דק'". Answered: "ענו", and a tap opens the
// conversation at the answer. Once he reads it hq drops the row, so an answer can't get lost in the list.
import 'package:flutter/material.dart';

import '../../data/backend.dart';
import '../../data/store.dart';
import '../../model/models.dart';
import '../../theme/tokens.dart';
import '../chat/chat_screen.dart';
import '../common.dart';
import '../convs/head.dart';
import '../nav.dart';
import 'parts.dart';

/// One request on the list: what he asked, of whom, since when, and the answer when there is one.
class AskedItem {
  const AskedItem({required this.id, required this.who, required this.text, required this.at, this.count = 1, this.reply, this.replyText, this.replyAt});

  /// His message id.
  final String id;
  final String who;
  final String text;
  final DateTime at;
  final int count;

  /// The answer's message id; null while it is open.
  final String? reply;
  final String? replyText;
  final DateTime? replyAt;

  bool get answered => reply != null;

  factory AskedItem.of(AskedRequest r) => AskedItem(
        id: r.id,
        who: r.identity,
        text: r.body,
        at: r.at,
        count: r.count,
        reply: r.state == AskedState.answered ? r.reply?.id : null,
        replyText: r.state == AskedState.answered ? r.reply?.body : null,
        replyAt: r.state == AskedState.answered ? r.reply?.at : null,
      );

  factory AskedItem.fromJson(Map<String, dynamic> j) => AskedItem(
        id: j['id'] as String,
        who: j['who'] as String,
        text: j['text'] as String? ?? '',
        at: DateTime.fromMillisecondsSinceEpoch(((j['at'] as num?) ?? 0).toInt()),
        count: (j['count'] as num?)?.toInt() ?? 1,
        reply: j['reply'] as String?,
        replyText: j['reply_text'] as String?,
        replyAt: j['reply_at'] is num ? DateTime.fromMillisecondsSinceEpoch((j['reply_at'] as num).toInt()) : null,
      );
  Map<String, dynamic> toJson() => {
        'id': id, 'who': who, 'text': text, 'at': at.millisecondsSinceEpoch, 'count': count,
        'reply': reply, 'reply_text': replyText, 'reply_at': replyAt?.millisecondsSinceEpoch,
      };
}

/// "ביקשת": his requests that wait, newest first.
class AskedData {
  const AskedData({required this.items});
  final List<AskedItem> items;

  /// All of them, or only [messages] (the recipe's ids, in its order). An id that left the list is gone.
  factory AskedData.of(CompanyData d, [List<String>? messages]) {
    if (messages == null) return AskedData(items: [for (final r in d.asked) AskedItem.of(r)]);
    final byId = {for (final r in d.asked) r.id: r};
    return AskedData(items: [for (final id in messages) if (byId[id] != null) AskedItem.of(byId[id]!)]);
  }

  factory AskedData.fromJson(Map<String, dynamic> j) => AskedData(items: [
        for (final x in (j['items'] as List? ?? const []).whereType<Map>())
          if (x['id'] is String && x['who'] is String) AskedItem.fromJson(x.cast<String, dynamic>()),
      ]);
  Map<String, dynamic> toJson() => {'items': [for (final x in items) x.toJson()]};
}

/// Opens [x]'s conversation at the answer (his own message while it is open).
void openAsked(BuildContext context, AskedItem x) {
  ChatScreen.pendingTarget[x.who] = x.reply ?? x.id;
  // A streamed answer sits under the engine's id, not the stored one: its start finds it.
  final text = x.answered ? x.replyText : x.text;
  if (text != null && text.trim().isNotEmpty) ChatScreen.pendingTargetText[x.who] = text;
  Nav.chat(context, x.who);
}

class AskedBlock extends StatelessWidget {
  const AskedBlock({super.key, required this.data, this.now});
  final AskedData data;

  /// For "לפני 12 דק'"; now when null.
  final DateTime? now;

  @override
  Widget build(BuildContext context) {
    final store = StoreScope.of(context);
    // Live data wins: a request he read the answer to leaves at once, one just answered says so.
    final live = {for (final r in store.data?.asked ?? const <AskedRequest>[]) r.id: r};
    final items = [
      for (final x in data.items)
        if (store.data == null) x else if (live[x.id] case final r?) AskedItem.of(r),
    ];
    return AnimatedSize(
      duration: kBlockMotion,
      curve: kBlockCurve,
      alignment: Alignment.topCenter,
      child: items.isEmpty
          ? const SizedBox(width: double.infinity)
          : Padding(
              padding: const EdgeInsets.symmetric(vertical: 4),
              child: Column(children: [
                for (final (i, x) in items.indexed) ...[
                  if (i > 0) const BlockHairline(),
                  _Row(key: ValueKey('asked-${x.id}'), x: x, now: now ?? DateTime.now()),
                ],
              ]),
            ),
    );
  }
}

/// "לעידו", and "ל-agent-company-t62" for a name in Latin letters.
String _to(String name) => RegExp(r'^[֐-׿]').hasMatch(name) ? 'ל$name' : 'ל-$name';

/// "לפני 12 דק'", "עכשיו".
String _ago(DateTime at, DateTime now) {
  final a = HeadData.ago(at, now);
  return a == 'עכשיו' ? a : 'לפני $a';
}

class _Row extends StatelessWidget {
  const _Row({super.key, required this.x, required this.now});
  final AskedItem x;
  final DateTime now;

  @override
  Widget build(BuildContext context) {
    final p = context.p;
    final d = StoreScope.of(context).data;
    final name = d == null ? x.who : d.who(x.who).name;
    final when = x.answered ? (x.replyAt ?? x.at) : x.at;
    final word = x.answered ? 'ענו' : 'מחכה ${_to(name)}';
    final rest = [if (x.answered) name, if (x.count > 1) '${x.count} הודעות', _ago(when, now)];
    final canOpen = d == null || (d.canChat(x.who) && d.identities.containsKey(x.who));
    final spoken = [
      'ביקשת מ$name: ${x.text}',
      x.answered ? 'ענו' : 'מחכה',
      if (x.count > 1) '${x.count} הודעות',
      HeadData.agoSpoken(when, now),
    ].join('. ');
    return Semantics(
      button: canOpen,
      label: spoken,
      hint: canOpen ? (x.answered ? 'פתיחת התשובה' : 'פתיחת השיחה') : null,
      excludeSemantics: true,
      child: InkWell(
        onTap: canOpen ? () => openAsked(context, x) : null,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 60),
          child: Padding(
            padding: const EdgeInsetsDirectional.fromSTEB(16, 10, 16, 10),
            child: Row(children: [
              BlockSymbol(x.answered ? 'reply' : 'schedule'),
              const SizedBox(width: 12),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                  Rich(x.text.split('\n').first, auto: true, maxLines: 1, overflow: TextOverflow.ellipsis, style: T.body.copyWith(fontWeight: FontWeight.w500, color: p.text, height: 21 / 15.5)),
                  const SizedBox(height: 2),
                  Text.rich(
                    TextSpan(children: [
                      TextSpan(text: word, style: const TextStyle(fontWeight: FontWeight.w700)),
                      TextSpan(text: ' · ${rest.join(' · ')}'),
                    ]),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: T.small.copyWith(color: p.text2),
                  ),
                ]),
              ),
              if (x.answered && canOpen) ...[
                const SizedBox(width: 8),
                Text('לתשובה', style: T.small.copyWith(fontWeight: FontWeight.w700, color: p.text)),
                Ic('chevron_left', size: 20, color: p.text2),
              ],
            ]),
          ),
        ),
      ),
    );
  }
}
