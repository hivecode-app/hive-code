// Selecting part of a message and copying it. The bubbles carry invisible bidi controls (LRI…PDI,
// word joiners) and thin spaces around inline code (bidi.dart, Rich.spans): SelectionArea's own
// copy would put them on the clipboard, and a pasted command or path would then not run. Here copy
// (the menu, share, and Ctrl+C) gives the source characters.
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';

import 'bidi.dart';

class CopySelectionArea extends StatefulWidget {
  const CopySelectionArea({super.key, required this.child});
  final Widget child;

  @override
  State<CopySelectionArea> createState() => _CopySelectionAreaState();
}

class _CopySelectionAreaState extends State<CopySelectionArea> {
  String _selected = '';

  Future<void> _copy() => Clipboard.setData(ClipboardData(text: stripBidi(_selected)));

  Widget _menu(BuildContext context, SelectableRegionState state) => AdaptiveTextSelectionToolbar.buttonItems(
        anchors: state.contextMenuAnchors,
        buttonItems: [
          for (final b in state.contextMenuButtonItems)
            switch (b.type) {
              ContextMenuButtonType.copy => b.copyWith(onPressed: () {
                  _copy();
                  // Android clears the selection after a copy; elsewhere it stays.
                  if (defaultTargetPlatform == TargetPlatform.android) state.clearSelection();
                  state.hideToolbar();
                }),
              ContextMenuButtonType.share => b.copyWith(onPressed: () {
                  SystemChannels.platform.invokeMethod('Share.invoke', stripBidi(_selected));
                  state.hideToolbar();
                }),
              _ => b,
            },
        ],
      );

  @override
  Widget build(BuildContext context) => Actions(
        // SelectableRegion's Ctrl+C is overridable from above.
        actions: {CopySelectionTextIntent: CallbackAction<CopySelectionTextIntent>(onInvoke: (_) => _copy())},
        child: SelectionArea(
          onSelectionChanged: (c) => _selected = c?.plainText ?? '',
          contextMenuBuilder: _menu,
          child: widget.child,
        ),
      );
}

/// The lines of one message copy as lines. Markdown gives every line its own Text (for its own
/// direction), and SelectionArea joins its texts with nothing between them ("(exit 0).All green").
class SelectionLines extends StatefulWidget {
  const SelectionLines({super.key, required this.child});
  final Widget child;
  @override
  State<SelectionLines> createState() => _SelectionLinesState();
}

class _SelectionLinesState extends State<SelectionLines> {
  final _delegate = _LinesDelegate();

  @override
  void dispose() {
    _delegate.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => SelectionContainer(delegate: _delegate, child: widget.child);
}

class _LinesDelegate extends StaticSelectionContainerDelegate {
  @override
  SelectedContent? getSelectedContent() {
    final parts = [
      for (final s in selectables)
        if (s.getSelectedContent() case final c? when c.plainText.isNotEmpty) c.plainText,
    ];
    return parts.isEmpty ? null : SelectedContent(plainText: parts.join('\n'));
  }
}
