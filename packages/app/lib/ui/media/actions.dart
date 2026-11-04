import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:share_plus/share_plus.dart';

import '../../data/store.dart';
import '../../l10n/app_localizations.dart';
import '../../model/models.dart';
import '../nav.dart';

Future<void> originalAction(BuildContext context, Attachment a, {bool share = false}) async {
  final store = StoreScope.read(context), l = AppLocalizations.of(context);
  store.notice(l.mediaLoading);
  store.touch();
  try {
    final bytes = a.data ?? await a.transfer?.read?.call() ?? (a.id == null ? null : await store.backend.attachmentData(a.id!));
    if (bytes == null) {
      store.notice(l.mediaUnavailable);
      store.touch();
      return;
    }
    final String result;
    if (share) {
      final box = context.mounted ? context.findRenderObject() as RenderBox? : null;
      final r = await SharePlus.instance.share(
        ShareParams(
          files: [XFile.fromData(bytes, mimeType: a.mime, name: a.name)],
          fileNameOverrides: [a.name],
          sharePositionOrigin: box == null ? null : box.localToGlobal(Offset.zero) & box.size,
        ),
      );
      result = r.status == ShareResultStatus.success
          ? l.mediaShared
          : r.status == ShareResultStatus.dismissed
          ? l.mediaCancelled
          : l.mediaActionFailed;
    } else {
      final path = await FilePicker.saveFile(fileName: a.name, bytes: bytes, mimeType: a.mime);
      result = path == null ? l.mediaCancelled : l.mediaSaved;
    }
    store.notice(result);
    store.touch();
  } catch (_) {
    store.notice(l.mediaActionFailed);
    store.touch();
  }
}

void fileReply(BuildContext context, Attachment a) {
  final store = StoreScope.read(context);
  final chat = store.data?.chats.entries
      .where(
        (e) => e.value.items.any(
          (m) => switch (m) {
            UserMsg m => m.attachments.any((f) => identical(f, a) || f.id != null && f.id == a.id),
            TextMsg m => m.attachments.any((f) => identical(f, a) || f.id != null && f.id == a.id),
            _ => false,
          },
        ),
      )
      .firstOrNull;
  final identity = a.meta['source_chat'] as String? ?? chat?.key;
  if (identity == null) {
    store.notice(AppLocalizations.of(context).mediaUnavailable);
    store.touch();
    return;
  }
  final source = chat?.value.items
      .where(
        (m) => switch (m) {
          UserMsg m => m.attachments.any((f) => identical(f, a) || f.id != null && f.id == a.id),
          TextMsg m => m.attachments.any((f) => identical(f, a) || f.id != null && f.id == a.id),
          _ => false,
        },
      )
      .firstOrNull;
  final author = a.meta['source_sender'] == 'owner' || source is UserMsg
      ? store.data?.ownerName.isNotEmpty == true
            ? store.data!.ownerName
            : AppLocalizations.of(context).mediaYou
      : store.data?.who(identity).name ?? '';
  final quote = Quote(author: author, text: '${a.name} (${a.id ?? ''})', itemId: a.meta['source_message'] as String? ?? source?.id);
  Nav.chat(context, identity, quote: quote, focus: true, preserveRoute: true);
}
