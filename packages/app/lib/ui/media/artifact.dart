import 'dismiss.dart';

import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/material.dart';

import '../../data/backend.dart';
import '../../data/hq_backend.dart' show ArtifactAccessFailure;
import '../../data/store.dart';
import '../../l10n/app_localizations.dart';
import '../../model/models.dart';
import '../../native/artifact_surface.dart';
import '../../native/open_url.dart';
import '../../theme/tokens.dart';
import '../common.dart';
import '../nav.dart';

void artifactDraft(BuildContext context, Map<String, dynamic> info, int version, {bool copy = false}) {
  final store = StoreScope.read(context), l = AppLocalizations.of(context);
  final owner = info['owner'] as String, id = info['id'] as String;
  final text = copy ? l.mediaAskCopy(id, '$version') : l.mediaArtifactReply(id, '$version');
  final current = store.data?.chats[owner]?.draft ?? '';
  store.setDraft(owner, current.isEmpty ? text : '$current\n$text');
  final quote = Quote(author: store.data?.who(owner).name ?? '', text: '${info['title']} · $id · ${l.mediaVersion('$version')}');
  store.touch();
  Nav.chat(context, owner, quote: quote, focus: true, preserveRoute: true);
}

class ArtifactCard extends StatefulWidget {
  const ArtifactCard({super.key, required this.info});
  final Map<String, dynamic> info;
  @override
  State<ArtifactCard> createState() => _ArtifactCardState();
}

class _ArtifactCardState extends State<ArtifactCard> {
  Future<Uint8List?>? _thumb;
  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _thumb ??= _load();
  }

  @override
  void didUpdateWidget(ArtifactCard old) {
    super.didUpdateWidget(old);
    if (old.info['latest'] != widget.info['latest']) _thumb = _load();
  }

  Future<Uint8List?> _load() async {
    try {
      return await StoreScope.read(context).backend.artifactThumb(widget.info['id'] as String);
    } catch (_) {
      return null;
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context), p = context.p, info = widget.info;
    final version = info['latest'] as int;
    final latest = (info['versions'] as List? ?? []).cast<Map>().where((v) => v['version'] == version).firstOrNull;
    return ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: 360),
      child: Material(
        color: p.surface,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(9),
          side: BorderSide(color: p.line),
        ),
        child: InkWell(
          onTap: () => Navigator.of(context).push(
            PageRouteBuilder<void>(
              pageBuilder: (_, _, _) => ArtifactScreen(id: info['id'] as String, version: version, initialInfo: info),
              transitionDuration: MediaQuery.disableAnimationsOf(context) ? Duration.zero : const Duration(milliseconds: 160),
            ),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [
              SizedBox(
                height: 140,
                child: FutureBuilder<Uint8List?>(
                  future: _thumb,
                  builder: (context, snap) => snap.data == null
                      ? Center(child: Ic('web', size: 38, color: p.text2))
                      : Image.memory(
                          snap.data!,
                          fit: BoxFit.cover,
                          errorBuilder: (_, _, _) => const Center(child: Ic('web')),
                        ),
                ),
              ),
              Padding(
                padding: const EdgeInsets.all(12),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(info['title'] as String, style: T.name),
                    if ((latest?['note'] as String? ?? '').isNotEmpty) Text(latest!['note'] as String, style: T.secondary),
                    const SizedBox(height: 4),
                    Wrap(
                      spacing: 8,
                      children: [
                        Text(l.mediaVersion('$version'), style: T.meta),
                        Text(l.mediaPrivate, style: T.meta),
                        Text(latest?['network'] == true ? l.mediaNetwork : l.mediaNoNetwork, style: T.meta),
                      ],
                    ),
                    if (info['expired'] == true)
                      Text(l.mediaExpired, style: T.secondary)
                    else
                      Text(info['pinned'] == true ? l.mediaKept : l.mediaExpires(_date(context, info['expires_at'] as int)), style: T.meta),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

String _date(BuildContext context, int at) => MaterialLocalizations.of(context).formatCompactDate(DateTime.fromMillisecondsSinceEpoch(at));

typedef ArtifactSurfaceBuilder = Widget Function(String url, void Function(String) blocked);

class ArtifactScreen extends StatefulWidget {
  const ArtifactScreen({super.key, required this.id, this.version, this.initialInfo, this.surfaceBuilder, this.comparing = false});
  final String id;
  final int? version;
  final Map<String, dynamic>? initialInfo;
  final ArtifactSurfaceBuilder? surfaceBuilder;
  final bool comparing;
  @override
  State<ArtifactScreen> createState() => _ArtifactScreenState();
}

class _ArtifactScreenState extends State<ArtifactScreen> {
  Backend? _backend;
  Map<String, dynamic>? _info;
  int? _version;
  String? _url, _outside;
  bool _loading = true, _expired = false, _failed = false, _keeping = false;
  int _request = 0;
  Timer? _renew;
  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_backend != null) return;
    _backend = StoreScope.read(context).backend;
    _backend!.artifactRevision.addListener(_refresh);
    _info = widget.initialInfo;
    _version = widget.version;
    _initial();
  }

  Future<void> _initial() async {
    await _refresh();
    if (!mounted) return;
    if (_info == null) {
      setState(() {
        _loading = false;
        _failed = true;
      });
      return;
    }
    await _open(_version ?? _info!['latest'] as int);
  }

  Future<void> _refresh() async {
    try {
      final info = await _backend!.artifact(widget.id);
      if (mounted && info != null) {
        setState(() {
          _info = info;
          if (info['expired'] == true) {
            _expired = true;
            _url = null;
            _renew?.cancel();
          }
        });
      }
    } catch (_) {
      if (mounted && _info == null) setState(() => _failed = true);
    }
  }

  Future<void> _open(int version) async {
    final request = ++_request;
    _renew?.cancel();
    setState(() {
      _loading = true;
      _failed = false;
      _expired = false;
      _outside = null;
      _url = null;
      _version = version;
    });
    try {
      final opened = await _backend!.openArtifact(widget.id, version);
      if (!mounted || request != _request) return;
      setState(() {
        _url = opened['url'] as String;
        _loading = false;
      });
      final expiry = opened['access_expires_at'] as int?;
      if (expiry != null) {
        final delay = DateTime.fromMillisecondsSinceEpoch(expiry).difference(CompanyTime.now()) - const Duration(seconds: 30);
        if (delay > Duration.zero) _renew = Timer(delay, () => _open(version));
      }
    } on ArtifactAccessFailure catch (e) {
      if (mounted && request == _request) {
        setState(() {
          _expired = e.status == 410 || e.status == 404;
          _failed = !_expired;
          _loading = false;
        });
      }
    } catch (_) {
      if (mounted && request == _request) {
        setState(() {
          _failed = true;
          _loading = false;
        });
      }
    }
  }

  Future<void> _keep() async {
    if (_keeping) return;
    setState(() => _keeping = true);
    final l = AppLocalizations.of(context);
    try {
      final ok = await _backend!.keepArtifact(widget.id);
      if (!mounted) return;
      if (ok) {
        await _refresh();
      } else {
        StoreScope.read(context).notice(l.mediaActionFailed);
        StoreScope.read(context).touch();
      }
    } catch (_) {
      if (mounted) {
        StoreScope.read(context).notice(l.mediaActionFailed);
        StoreScope.read(context).touch();
      }
    } finally {
      if (mounted) setState(() => _keeping = false);
    }
  }

  Future<void> _window() async {
    final l = AppLocalizations.of(context), store = StoreScope.read(context);
    try {
      final url = _url;
      if (url == null) return;
      if (!await openExternalUrl(url)) {
        store.notice(l.mediaActionFailed);
        store.touch();
      }
    } catch (_) {
      store.notice(l.mediaActionFailed);
      store.touch();
    }
  }

  @override
  void dispose() {
    _request++;
    _renew?.cancel();
    _backend?.artifactRevision.removeListener(_refresh);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context), info = _info;
    final versions = (info?['versions'] as List? ?? const []).cast<Map>();
    final current = versions.where((v) => v['version'] == _version).firstOrNull;
    final store = StoreScope.of(context);
    final title = current?['title'] as String? ?? info?['title'] as String? ?? l.mediaApps;
    return DismissMedia(
      child: Scaffold(
        appBar: AppBar(
          toolbarHeight: mediaToolbarHeight(context, title),
          leading: IconButton(tooltip: l.close, onPressed: () => Navigator.maybePop(context), icon: const Ic('close')),
          title: Text(title, maxLines: 3, overflow: TextOverflow.ellipsis),
          actions: [
            if (info != null)
              PopupMenuButton<String>(
                tooltip: l.mediaMore,
                icon: const Ic('more_vert'),
                onSelected: (key) {
                  switch (key) {
                    case 'keep':
                      _keep();
                    case 'reply':
                      artifactDraft(context, info, _version!);
                    case 'window':
                      _window();
                    case 'compare':
                      Navigator.of(context).push(
                        MaterialPageRoute<void>(
                          builder: (_) => ArtifactCompare(info: info, initial: _version!, surfaceBuilder: widget.surfaceBuilder),
                        ),
                      );
                  }
                },
                itemBuilder: (_) => [
                  PopupMenuItem(value: 'reply', child: Text(l.mediaReply)),
                  PopupMenuItem(value: 'keep', enabled: !_keeping && info['pinned'] != true, child: Text(l.mediaKeep)),
                  PopupMenuItem(value: 'window', enabled: _url != null && !_expired, child: Text(l.mediaOpenWindow)),
                  if (!widget.comparing && versions.length > 1) PopupMenuItem(value: 'compare', child: Text(l.mediaCompare)),
                ],
              ),
          ],
        ),
        body: Column(
          children: [
            if (info != null)
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('${store.data?.who(info['owner'] as String).name ?? ''} · ${info['task_id'] == null ? '' : l.mediaTask('${info['task_id']}')}', style: T.secondary),
                    Wrap(
                      spacing: 12,
                      crossAxisAlignment: WrapCrossAlignment.center,
                      children: [
                        if (!widget.comparing)
                          SizedBox(
                            width: MediaQuery.sizeOf(context).width < 352 ? MediaQuery.sizeOf(context).width - 32 : 320,
                            child: Tooltip(
                              message: l.mediaVersion('$_version'),
                              child: DropdownButton<int>(
                                icon: const Ic('expand_more'),
                                isExpanded: true,
                                value: versions.any((v) => v['version'] == _version) ? _version : null,
                                items: [
                                  for (final v in versions)
                                    DropdownMenuItem(
                                      value: v['version'] as int,
                                      child: Text(
                                        '${l.mediaVersion('${v['version']}')}${(v['note'] as String? ?? '').isEmpty ? '' : ': ${v['note']}'}',
                                        overflow: TextOverflow.ellipsis,
                                      ),
                                    ),
                                ],
                                onChanged: (v) {
                                  if (v != null) _open(v);
                                },
                              ),
                            ),
                          ),
                        if (widget.comparing) Text(l.mediaVersion('$_version'), style: T.meta),
                        Text(l.mediaPrivate, style: T.meta),
                        Text(current?['network'] == true ? l.mediaNetwork : l.mediaNoNetwork, style: T.meta),
                        Text(info['pinned'] == true ? l.mediaKept : l.mediaExpires(_date(context, info['expires_at'] as int)), style: T.meta),
                      ],
                    ),
                    if (_version != null && (info['latest'] as int) > _version!) TextButton(onPressed: () => _open(info['latest'] as int), child: Text(l.mediaNewVersion)),
                  ],
                ),
              ),
            if (_keeping) const LinearProgressIndicator(),
            Expanded(
              child: _loading
                  ? Center(
                      child: Column(mainAxisSize: MainAxisSize.min, children: [const CircularProgressIndicator(), Text(l.mediaLoading)]),
                    )
                  : _expired
                  ? Center(
                      child: Padding(
                        padding: const EdgeInsets.all(24),
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Text(l.mediaExpired),
                            if (info != null) TextButton(onPressed: () => artifactDraft(context, info, _version!, copy: true), child: Text(l.mediaAskAgain)),
                          ],
                        ),
                      ),
                    )
                  : _failed
                  ? Center(
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Text(l.mediaPreviewFailed),
                          TextButton(onPressed: () => _version == null ? _initial() : _open(_version!), child: Text(l.mediaRefreshAccess)),
                        ],
                      ),
                    )
                  : _outside != null
                  ? Center(
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Text(l.mediaBlockedNavigation),
                          if (Uri.tryParse(_outside!)?.scheme == 'https') TextButton(onPressed: () => openExternalUrl(_outside!), child: Text(l.mediaOpenWindow)),
                        ],
                      ),
                    )
                  : _url == null
                  ? const SizedBox.shrink()
                  : KeyedSubtree(
                      key: ValueKey(_url),
                      child: (widget.surfaceBuilder ?? artifactSurface)(_url!, (url) {
                        if (mounted) setState(() => _outside = url);
                      }),
                    ),
            ),
          ],
        ),
      ),
    );
  }
}

class ArtifactCompare extends StatefulWidget {
  const ArtifactCompare({super.key, required this.info, required this.initial, this.surfaceBuilder});
  final Map<String, dynamic> info;
  final int initial;
  final ArtifactSurfaceBuilder? surfaceBuilder;
  @override
  State<ArtifactCompare> createState() => _ArtifactCompareState();
}

class _ArtifactCompareState extends State<ArtifactCompare> {
  late int _left = widget.initial, _right = (widget.info['versions'] as List).cast<Map>().map((v) => v['version'] as int).firstWhere((n) => n != widget.initial);
  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context), versions = (widget.info['versions'] as List).cast<Map>();
    Widget pane(bool left) => Column(
      children: [
        Tooltip(
          message: '${l.mediaCompare} · ${l.mediaVersion('${left ? _left : _right}')}',
          child: DropdownButton<int>(
            value: left ? _left : _right,
            items: [for (final v in versions) DropdownMenuItem(value: v['version'] as int, child: Text(l.mediaVersion('${v['version']}')))],
            onChanged: (v) {
              if (v != null && v != (left ? _right : _left)) {
                setState(() {
                  if (left) {
                    _left = v;
                  } else {
                    _right = v;
                  }
                });
              }
            },
          ),
        ),
        Expanded(
          child: ArtifactScreen(
            key: ValueKey(left ? 'left-$_left' : 'right-$_right'),
            id: widget.info['id'] as String,
            version: left ? _left : _right,
            initialInfo: widget.info,
            surfaceBuilder: widget.surfaceBuilder,
            comparing: true,
          ),
        ),
      ],
    );
    return Scaffold(
      appBar: AppBar(title: Text(l.mediaCompare)),
      body: LayoutBuilder(
        builder: (context, box) => box.maxWidth >= 840
            ? Row(
                children: [
                  Expanded(child: pane(true)),
                  const VerticalDivider(width: 1),
                  Expanded(child: pane(false)),
                ],
              )
            : Column(
                children: [
                  Expanded(child: pane(true)),
                  const Divider(height: 1),
                  Expanded(child: pane(false)),
                ],
              ),
      ),
    );
  }
}
