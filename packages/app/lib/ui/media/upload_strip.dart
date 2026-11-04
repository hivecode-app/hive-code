import 'package:flutter/material.dart';

import '../../data/store.dart';
import '../../l10n/app_localizations.dart';
import '../../model/models.dart';
import '../../theme/tokens.dart';
import '../common.dart';

class UploadStrip extends StatelessWidget {
  const UploadStrip({super.key, required this.files, required this.onRemove});
  final List<Attachment> files;
  final void Function(Attachment) onRemove;
  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context), p = context.p;
    final store = StoreScope.read(context);
    return ConstrainedBox(
      constraints: BoxConstraints(maxHeight: 210 * MediaQuery.textScalerOf(context).scale(1).clamp(1, 1.6)),
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            for (final a in files)
              Material(
                color: p.surface,
                borderRadius: BorderRadius.circular(8),
                child: Padding(
                  padding: const EdgeInsetsDirectional.fromSTEB(10, 4, 0, 4),
                  child: Row(
                    children: [
                      if (a.isImage && a.data != null)
                        ClipRRect(
                          borderRadius: BorderRadius.circular(4),
                          child: Image.memory(a.data!, width: 42, height: 42, fit: BoxFit.cover, errorBuilder: (_, _, _) => const Ic('image')),
                        )
                      else
                        const Ic('description'),
                      const SizedBox(width: 10),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(a.name, maxLines: 2, style: T.secondary, textDirection: firstStrongDirection(a.name)),
                            Semantics(
                              liveRegion: true,
                              label:
                                  '${a.name}: ${a.id != null
                                      ? l.mediaReady
                                      : store.uploadFailed(a)
                                      ? l.mediaFailed
                                      : l.mediaUploading('${((a.transfer?.progress ?? 0) * 4).floor() * 25}')} ',
                              child: ExcludeSemantics(
                                child: Text(
                                  a.id != null
                                      ? l.mediaReady
                                      : store.uploadFailed(a)
                                      ? l.mediaFailed
                                      : l.mediaUploading('${((a.transfer?.progress ?? 0) * 100).floor()}'),
                                  style: T.meta.copyWith(color: p.text2),
                                ),
                              ),
                            ),
                            if (a.isImage && a.meta['app_original'] is bool) Text(a.meta['app_original'] == true ? l.mediaOriginal : l.mediaReduced, style: T.meta),
                            if (a.id == null && !store.uploadFailed(a))
                              LinearProgressIndicator(
                                value: a.transfer?.progress,
                                minHeight: 2,
                                semanticsLabel: l.mediaUploading('${((a.transfer?.progress ?? 0) * 100).floor()}'),
                              ),
                          ],
                        ),
                      ),
                      if (store.uploadFailed(a))
                        IconButton(
                          tooltip: l.mediaRetry,
                          onPressed: () {
                            final chat = store.data?.chats.keys.where((id) => store.images(id).contains(a)).firstOrNull;
                            if (chat != null) store.retryUpload(chat, a);
                          },
                          icon: const Ic('refresh'),
                        ),
                      IconButton(tooltip: l.mediaRemove(a.name), onPressed: () => onRemove(a), icon: const Ic('close')),
                    ],
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
