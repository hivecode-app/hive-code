import 'package:flutter/material.dart';

import '../../data/store.dart';
import '../../l10n/app_localizations.dart';
import '../../native/native_bridge.dart';
import '../common.dart';

class ShareReview extends StatefulWidget {
  const ShareReview({super.key, required this.payload, required this.store});
  final SharedPayload payload;
  final AppStore store;
  @override
  State<ShareReview> createState() => _ShareReviewState();
}

class _ShareReviewState extends State<ShareReview> {
  String? _to;
  @override
  void initState() {
    super.initState();
    final ids = widget.store.data!.conversations.where((c) => widget.store.data!.canChat(c.identityId)).map((c) => c.identityId);
    _to = ids.contains(widget.payload.identityId) ? widget.payload.identityId : ids.firstOrNull;
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context), d = widget.store.data!;
    return SingleChildScrollView(
      child: Padding(
        padding: EdgeInsets.fromLTRB(20, 16, 20, MediaQuery.viewInsetsOf(context).bottom + 20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(l.mediaShareReview, style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: 16),
            DropdownButtonFormField<String>(
              initialValue: _to,
              isExpanded: true,
              items: [for (final c in d.conversations.where((c) => d.canChat(c.identityId))) DropdownMenuItem(value: c.identityId, child: Text(d.who(c.identityId).name))],
              onChanged: (v) => setState(() => _to = v),
            ),
            if (_to != null) Padding(padding: const EdgeInsets.symmetric(vertical: 12), child: Text('${d.who(_to!).name} · ${d.roleLine(_to!)}')),
            if (widget.payload.text?.isNotEmpty == true) Text(widget.payload.text!),
            for (final file in widget.payload.files) ListTile(contentPadding: EdgeInsets.zero, leading: const Ic('description'), title: Text(file.name)),
            for (final name in widget.payload.errors) Padding(padding: const EdgeInsets.symmetric(vertical: 8), child: Text(l.mediaReadFailed(name))),
            if (_to != null && (d.chats[_to!]?.draft.isNotEmpty ?? false)) Padding(padding: const EdgeInsets.symmetric(vertical: 12), child: Text(d.chats[_to!]!.draft)),
            const SizedBox(height: 12),
            Wrap(
              spacing: 12,
              children: [
                TextButton(onPressed: () => Navigator.pop(context), child: Text(l.mediaCancelAction)),
                FilledButton(onPressed: _to == null ? null : () => Navigator.pop(context, _to), child: Text(l.mediaAddToDraft)),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
