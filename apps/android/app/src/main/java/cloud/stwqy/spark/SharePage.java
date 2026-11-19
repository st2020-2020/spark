package cloud.stwqy.spark;

import android.app.Activity;
import android.os.Build;
import android.text.InputFilter;
import android.text.InputType;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

final class SharePage {
    final LinearLayout column;
    final TextView status;
    private final Activity activity;

    SharePage(Activity activity, String title) {
        this.activity = activity;
        ScrollView scroll = new ScrollView(activity);
        scroll.setFillViewport(true);
        column = new LinearLayout(activity);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setPadding(dp(20), dp(16), dp(20), dp(24));
        column.setFocusableInTouchMode(true);
        scroll.addView(column);
        activity.setContentView(scroll);
        TextView heading = label(title, 22);
        if (Build.VERSION.SDK_INT >= 28) heading.setAccessibilityHeading(true);
        status = label("", 14);
        status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
    }

    TextView label(String value, int size) {
        TextView label = new TextView(activity);
        label.setText(value);
        label.setTextSize(size);
        label.setPadding(0, dp(4), 0, dp(4));
        column.addView(label);
        return label;
    }

    EditText field(String name, String value, boolean frozen, int lines) {
        TextView label = label(name, 14);
        EditText field = new EditText(activity);
        field.setId(View.generateViewId());
        label.setLabelFor(field.getId());
        field.setSaveEnabled(false);
        if (Build.VERSION.SDK_INT >= 26) {
            field.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
        }
        field.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE);
        field.setGravity(android.view.Gravity.TOP | android.view.Gravity.START);
        field.setMinLines(lines);
        field.setMaxLines(lines + 5);
        field.setText(value);
        field.setFilters(new InputFilter[]{(source, start, end, dest, dstart, dend) -> {
            if ((long) dest.length() - (dend - dstart) + (end - start) <= 100000) return null;
            status.setText("输入过长，请分段收藏。");
            return dest.subSequence(dstart, dend);
        }});
        field.setEnabled(!frozen);
        column.addView(field);
        return field;
    }

    Button button(String text, Runnable action) {
        Button b = new Button(activity);
        b.setText(text);
        b.setMinHeight(dp(48));
        b.setOnClickListener(v -> action.run());
        column.addView(b);
        return b;
    }

    void enableControls(boolean enabled) {
        for (int i = 0; i < column.getChildCount(); i++) {
            column.getChildAt(i).setEnabled(enabled);
        }
    }

    private int dp(int units) {
        return Math.round(units * activity.getResources().getDisplayMetrics().density);
    }
}
