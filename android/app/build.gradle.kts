plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Optional signing material for a real release build. Supply it as Gradle
// properties (-PstoreFile=… -PstorePassword=… -PkeyAlias=… -PkeyPassword=…),
// or through the environment, and never commit the keystore itself.
val releaseStoreFile: String? =
    (findProperty("storeFile") as String?) ?: System.getenv("TRAILPIN_STORE_FILE")
val releaseStorePassword: String? =
    (findProperty("storePassword") as String?) ?: System.getenv("TRAILPIN_STORE_PASSWORD")
val releaseKeyAlias: String? =
    (findProperty("keyAlias") as String?) ?: System.getenv("TRAILPIN_KEY_ALIAS")
val releaseKeyPassword: String? =
    (findProperty("keyPassword") as String?) ?: System.getenv("TRAILPIN_KEY_PASSWORD")

android {
    namespace = "com.trailpin.tracker"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.trailpin.tracker"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"

        // TrailPin talks to whatever host the user types in, so no endpoint is
        // baked in here. Everything is runtime configuration.
        resValue("string", "tracker_version", versionName)
    }

    signingConfigs {
        if (releaseStoreFile != null) {
            create("release") {
                storeFile = rootProject.file(releaseStoreFile)
                storePassword = releaseStorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
            }
        }
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
        }
        release {
            // Sideloading is the primary distribution channel, so the release
            // variant is signed with the debug key unless a keystore is supplied
            // through Gradle properties or the environment.
            isMinifyEnabled = false
            isShrinkResources = false
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    packaging {
        resources {
            excludes += setOf("META-INF/*.kotlin_module")
        }
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")

    testImplementation("junit:junit:4.13.2")
}
