import groovy.json.JsonSlurper
import java.util.Properties

plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

// One owner's Android values stay out of the repo, in the directory HIVECODE_ANDROID_CONFIG (scripts/deploy.sh sets it
// to <COMPANY_HOME>/company/local/android when that exists): android.properties (applicationId=...) and the Firebase
// project's google-services.json. Without it: app.hivecode, and google-services.json next to this file if there is one
// (gitignored). Without any google-services.json the app has no FCM and takes hq's other paths (docs/generic/INSTALL.md).
val androidConfig: File? = System.getenv("HIVECODE_ANDROID_CONFIG")?.takeIf { it.isNotBlank() }?.let { file(it) }
if (androidConfig != null && !androidConfig.isDirectory) throw GradleException("HIVECODE_ANDROID_CONFIG=$androidConfig is not a directory")
val androidProps = Properties()
androidConfig?.resolve("android.properties")?.takeIf { it.exists() }?.inputStream()?.use { androidProps.load(it) }
val appId: String = androidProps.getProperty("applicationId")?.trim()?.takeIf { it.isNotEmpty() } ?: "app.hivecode"
val googleServices: File? = listOfNotNull(androidConfig?.resolve("google-services.json"), file("google-services.json"))
    .firstOrNull { it.exists() }

/** The string resources the google-services plugin would generate (FirebaseOptions.fromResource reads them). */
@Suppress("UNCHECKED_CAST")
fun firebaseValues(json: File, packageName: String): Map<String, String> {
    val root = JsonSlurper().parse(json) as Map<String, Any?>
    val project = root["project_info"] as Map<String, Any?>
    val client = (root["client"] as List<Map<String, Any?>>).firstOrNull {
        ((it["client_info"] as Map<String, Any?>)["android_client_info"] as Map<String, Any?>)["package_name"] == packageName
    } ?: throw GradleException("$json has no Android app for $packageName: add it in the Firebase console and download the file again")
    val apiKey = (client["api_key"] as List<Map<String, Any?>>).first()["current_key"] as String
    val values = mutableMapOf(
        "google_app_id" to (client["client_info"] as Map<String, Any?>)["mobilesdk_app_id"] as String,
        "gcm_defaultSenderId" to project["project_number"] as String,
        "google_api_key" to apiKey,
        "google_crash_reporting_api_key" to apiKey,
        "project_id" to project["project_id"] as String,
    )
    (project["storage_bucket"] as String?)?.let { values["google_storage_bucket"] = it }
    (project["firebase_url"] as String?)?.let { values["firebase_database_url"] = it }
    return values
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
        applicationId = appId
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
        // FCM (task 1474, hq/PushService.kt), only with a Firebase project of this applicationId.
        googleServices?.let { json -> firebaseValues(json, appId).forEach { (k, v) -> resValue("string", k, v) } }
    }

    buildFeatures {
        resValues = true
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
    // hq's push (PushService, task 1474). Without the Firebase values above FirebaseApp is not initialised, and
    // PushRegistration catches that.
    implementation(platform("com.google.firebase:firebase-bom:35.1.0"))
    implementation("com.google.firebase:firebase-messaging")
    // Passkeys (#23): Credential Manager, with Google Password Manager on Android 13 and older.
    implementation("androidx.credentials:credentials:1.5.0")
    implementation("androidx.credentials:credentials-play-services-auth:1.5.0")
    testImplementation("junit:junit:4.13.2")
    // android.jar ships org.json as stubs; the real one lets parsers run in JVM unit tests.
    testImplementation("org.json:json:20250517")
}
