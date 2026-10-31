// How the conversation scrolls (task 1014): it never moves under his eyes. The list is two slivers around
// an anchor: the history up to the anchor grows upward from it, and everything newer grows downward below
// it. A message that arrives, or a reply that streams in, lands below the anchor, so what he reads stays
// where it is; at the bottom the view follows the end in the same frame. A jump to a card far up in the
// history moves the anchor to the card: one jump, no scrolling a screen at a time until it is built.
import 'dart:math' as math;

import 'package:flutter/rendering.dart';
import 'package:flutter/widgets.dart';

class ChatScrollController extends ScrollController {
  /// Where the next layout puts the anchor: a share of the screen above the bottom ([_anchorAt]), or pixels
  /// above it ([_anchorPx]); or the view at the end ([_end]).
  double? _anchorAt;
  double? _anchorPx;
  bool _end = false;

  /// Puts the anchor at the next layout (as far as the history allows) [fraction] of the screen above the
  /// bottom, or [pixels] above it: the bottom stays put when the screen above the list changes (the banner
  /// goes), so a place on screen is kept in pixels from it.
  /// From a build, [relayout] false: the rows that moved around the anchor lay the list out anyway, and
  /// [settle] after the frame covers a jump where none moved.
  void showAnchor({double? fraction, double? pixels, bool relayout = true}) {
    _anchorAt = fraction;
    _anchorPx = fraction == null ? pixels : null;
    _end = false;
    if (relayout) _relayout();
  }

  /// A jump still waiting for a layout gets one now, not at some later layout in the middle of his reading.
  void settle() {
    if (_anchorAt != null || _anchorPx != null || _end) _relayout();
  }

  /// The end of the conversation at the next layout, and following it from there.
  void showEnd() {
    _end = true;
    _anchorAt = null;
    _anchorPx = null;
    _relayout();
  }

  // The list lays out again even when nothing in it was rebuilt.
  void _relayout() {
    if (hasClients) (position as _ChatPosition).relayout();
  }

  /// At the end: new content keeps it at the end. Before the first layout, it is.
  bool get atEnd => !hasClients || (position as _ChatPosition).pinned;

  /// His finger is on the list: the rows don't move between the slivers under it.
  bool get held => hasClients && (position as _ChatPosition).held;

  /// How far above the end the view is, in pixels.
  double get fromEnd => !hasClients || !position.hasContentDimensions ? 0 : position.pixels - position.minScrollExtent;

  @override
  ScrollPosition createScrollPosition(ScrollPhysics physics, ScrollContext context, ScrollPosition? oldPosition) =>
      _ChatPosition(this, physics: physics, context: context, oldPosition: oldPosition);
}

class _ChatPosition extends ScrollPositionWithSingleContext {
  _ChatPosition(this.owner, {required super.physics, required super.context, super.oldPosition});
  final ChatScrollController owner;

  /// Following the end. Only a scroll of his (or a jump) changes it; content growing below never does.
  bool pinned = true;

  void relayout() => notifyListeners();

  bool get held => activity is DragScrollActivity || activity is HoldScrollActivity;

  RenderViewport? _vp;

  /// The list's viewport, found once under the scrollable.
  RenderViewport? get _viewport {
    if (_vp?.attached ?? false) return _vp;
    RenderViewport? found;
    void visit(RenderObject o) {
      if (found != null) return;
      if (o is RenderViewport) {
        found = o;
        return;
      }
      o.visitChildren(visit);
    }

    final root = context.notificationContext?.findRenderObject();
    if (root != null) visit(root);
    return _vp = found;
  }

  /// How tall the history above the anchor is, as this layout measured it (null: not laid out).
  double? _aboveAnchor() {
    final vp = _viewport;
    var e = 0.0;
    for (RenderSliver? s = vp?.center; s != null; s = vp!.childAfter(s)) {
      final g = s.geometry;
      if (g == null) return null;
      e += g.scrollExtent;
    }
    return vp?.center == null ? null : e;
  }

  void _track() {
    if (hasContentDimensions) pinned = pixels <= minScrollExtent + 1.5;
  }

  @override
  double setPixels(double newPixels) {
    final r = super.setPixels(newPixels);
    _track();
    return r;
  }

  @override
  void forcePixels(double value) {
    super.forcePixels(value);
    _track();
  }

  @override
  bool applyContentDimensions(double minScrollExtent, double maxScrollExtent) {
    // The viewport lets the view go up to the anchor at the bottom of the screen (0) even when there is less
    // than a screen of history above it: an empty band over the conversation. The top is where it starts.
    final above = _aboveAnchor();
    if (above != null) maxScrollExtent = math.max(minScrollExtent, math.min(maxScrollExtent, above - viewportDimension));
    final grew = !hasContentDimensions || minScrollExtent != this.minScrollExtent;
    final ok = super.applyContentDimensions(minScrollExtent, maxScrollExtent);
    double? to;
    final lift = owner._anchorPx ?? (owner._anchorAt == null ? null : owner._anchorAt! * viewportDimension);
    if (lift != null) {
      // The reverse list's anchor edge is the bottom at 0: a negative offset lifts it up the screen.
      to = (-lift).clamp(minScrollExtent, maxScrollExtent);
      owner._anchorAt = null;
      owner._anchorPx = null;
      pinned = to <= minScrollExtent + 1.5;
    } else if (owner._end) {
      owner._end = false;
      pinned = true;
      to = minScrollExtent;
    } else if (pinned && grew && activity is! DragScrollActivity) {
      // Something below grew (a new message, a streaming reply): stay at the end.
      to = minScrollExtent;
    }
    if (to != null && (to - pixels).abs() > 0.01) {
      // In this layout, before the frame is painted: no frame where the view sits in the wrong place.
      if (activity is BallisticScrollActivity || activity is DrivenScrollActivity) goIdle();
      correctPixels(to);
      return false;
    }
    return ok;
  }
}
