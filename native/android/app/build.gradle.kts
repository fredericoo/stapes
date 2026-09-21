plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "app.stapes"
    compileSdk = 35

    defaultConfig {
        applicationId = "app.stapes"
        // 26 is where a launcher reads an adaptive icon, which is what lets
        // the icon be the one vector in `res/drawable` rather than a bitmap per
        // density that somebody has to regenerate.
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // No signing config. A keystore is per machine and per account and
            // does not belong in the repository — Play App Signing takes an
            // unsigned bundle and signs it, and a local release build is signed
            // from `~/.gradle/gradle.properties`. @see native/README.md
        }
    }

    buildFeatures {
        viewBinding = true
        // Off by default since Android Gradle Plugin 8, and `StapesApp` reads
        // `BuildConfig.DEBUG` to decide whether to open the page to devtools.
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
}
