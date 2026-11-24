package cloud.stwqy.spark.feature.drafts

import android.app.Activity
import android.content.Intent
import android.os.Bundle

class DraftsShortcutActivity : Activity() {
    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        // A static shortcut can clear its target task. The trampoline has no workspace affinity.
        if (intent.action == "$packageName.OPEN_LOCAL_DRAFTS") {
            startActivity(Intent(this, LocalDraftsActivity::class.java))
        }
        finish()
    }
}
