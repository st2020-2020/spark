package cloud.stwqy.spark;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;

public final class DraftsShortcutActivity extends Activity {
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        // Static launcher shortcuts clear their target task. Keep it separate
        // so a shortcut cannot clear the running Web or system-share activity.
        startActivity(new Intent(this, ShareActivity.class).setAction(Intent.ACTION_MAIN));
        finish();
    }
}
