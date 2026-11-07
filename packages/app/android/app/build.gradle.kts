import java.util.Properties

plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
    // FCM (task 1474). google-services.json is the Firebase project's public config (no secret), committed next to this file.
    id("com.google.gms.google-services")
}

android {
    namespace = "app.hivecode"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        applicationId = "app.hivecode"
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        // 26: adaptive icons, notification channels and createWithAdaptiveBitmap are all baseline.
        minSdk = maxOf(26, flutter.minSdkVersion)
        targetSdk = flutter.targetSdkVersion
        // Uses the version code from pubspec.yaml. When using split APKs, 1000 * ABI_VERSION
        // is added automatically by Flutter. (https://developer.android.com/studio/build/configure-apk-splits#configure-APK-versions)
        // You can force using the value of versionCode by specifying the `-P force-version-code-ignoring-abi=true`
        // flag during build.
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    // Release key lives outside the repo: ~/.local/state/agent-company/android/key.properties
    // (override with AGENT_COMPANY_KEY_PROPERTIES). Without it, release falls back to the debug key.
    val keyProps = Properties()
    val keyFile = file(System.getenv("AGENT_COMPANY_KEY_PROPERTIES")
        ?: "${System.getProperty("user.home")}/.local/state/agent-company/android/key.properties")
    if (keyFile.exists()) keyFile.inputStream().use { keyProps.load(it) }

    signingConfigs {
        if (keyProps.getProperty("storeFile") != null) {
            create("release") {
                storeFile = file(keyProps.getProperty("storeFile"))
                storePassword = keyProps.getProperty("storePassword")
                keyAlias = keyProps.getProperty("keyAlias")
                keyPassword = keyProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
            // Classes reached only over JNI from Dart (#52); see the file.
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}

dependencies {
    implementation("androidx.work:work-runtime-ktx:2.11.2")
    implementation("androidx.core:core-ktx:1.17.0")
    // REST to hq from the push service and receivers, without the Flutter engine.
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    // hq's push (PushService, task 1474).
    implementation(platform("com.google.firebase:firebase-bom:35.1.0"))
    implementation("com.google.firebase:firebase-messaging")
    // Passkeys (#23): Credential Manager, with Google Password Manager on Android 13 and older.
    implementation("androidx.credentials:credentials:1.5.0")
    implementation("androidx.credentials:credentials-play-services-auth:1.5.0")
    testImplementation("junit:junit:4.13.2")
    // android.jar ships org.json as stubs; the real one lets parsers run in JVM unit tests.
    testImplementation("org.json:json:20250517")
}
