# Keep the Room schema types and generated adapters used to open the migrated database.
-keepclassmembers class cloud.stwqy.spark.core.storage.** { @androidx.room.** <methods>; }
-keep @androidx.room.Entity class cloud.stwqy.spark.core.storage.** { *; }

# Keep generated serializers and companions for native API models. kotlinx.serialization
# and Room also provide consumer rules for their own runtime internals.
-keepclassmembers @kotlinx.serialization.Serializable class cloud.stwqy.spark.core.network.** {
    static ** Companion;
}
-keepclassmembers class cloud.stwqy.spark.core.network.**$Companion {
    kotlinx.serialization.KSerializer serializer(...);
}
-keep class cloud.stwqy.spark.core.network.**$$serializer { *; }

# The framework dispatches these callbacks through WebViewClient. The host does not
# expose annotated JavaScript interfaces.
-keepclassmembers class cloud.stwqy.spark.** extends android.webkit.WebViewClient {
    public <methods>;
}
