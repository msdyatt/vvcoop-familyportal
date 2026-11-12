package org.veritasvillage.family;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.os.Build;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    /** Must match URGENT_ANDROID_CHANNEL in supabase/functions/_shared/fcm.ts. */
    private static final String URGENT_CHANNEL_ID = "urgent";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        createUrgentChannel();
    }

    /**
     * Urgent broadcasts (a closure because of weather) arrive on their own high-importance channel, so
     * they make a sound and appear as a heads-up banner even when ordinary notifications are quiet.
     * Android only allows a channel to be created once; the person can still change it in Settings.
     */
    private void createUrgentChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) return;
        NotificationChannel channel = new NotificationChannel(URGENT_CHANNEL_ID, "Urgent alerts", NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription("Closures and other urgent messages from Veritas Village.");
        channel.enableVibration(true);
        manager.createNotificationChannel(channel);
    }
}
