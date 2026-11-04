import 'package:flutter/widgets.dart';

import 'artifact_surface_io.dart' if (dart.library.js_interop) 'artifact_surface_web.dart' as impl;

/// The chrome is a Flutter sibling, never part of the worker-controlled document.
Widget artifactSurface(String url, void Function(String url) onBlocked) => impl.artifactSurface(url, onBlocked);
