# TrailPin keeps no reflection-based entry points of its own: the only classes
# loaded by name are Android components declared in the manifest. Minification is
# off by default, so this file exists mainly as documentation for anyone who
# turns it on.
-keep class com.trailpin.tracker.MainActivity { *; }
-keep class com.trailpin.tracker.TrackerService { *; }
-keep class com.trailpin.tracker.BootReceiver { *; }
-keep class com.trailpin.tracker.TrackerAlarmReceiver { *; }
