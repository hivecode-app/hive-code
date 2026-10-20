# shared_preferences_android 2.5 is called from Dart over JNI (package:jni), by name and by
# signature, e.g. getAll(String, List, kotlin.coroutines.Continuation). R8 sees no Java caller, so
# it renamed Continuation (to "ia") and the lookup failed: in a release build every prefs call threw
# NoSuchMethodError, the token was never saved and the app went back to sign-in (#52). The plugin
# ships no consumer rules for this. Keep its classes and the coroutine types in their signatures.
-keep class io.flutter.plugins.sharedpreferences.** { *; }
-keep class kotlin.coroutines.** { *; }
-keep class kotlin.Result { *; }
-keep class kotlin.Result$Failure { *; }
-keep class kotlin.jvm.functions.** { *; }
