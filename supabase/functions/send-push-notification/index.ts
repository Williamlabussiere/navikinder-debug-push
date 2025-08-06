// supabase/functions/send-push-notification/index.ts
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.53.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

interface PushNotificationRequest {
  dose_instance_id: string;
  due_datetime: string;
  dose_amount: number;
  dose_unit: string;
  medication_name: string;
  child_name: string;
  parent_email: string;
  parent_name: string;
}

// CRITICAL: Manual web push implementation for iOS compatibility
async function sendWebPushNotification(
  subscription: any,
  payload: string,
  vapidPublicKey: string,
  vapidPrivateKey: string,
  vapidEmail: string
) {
  // Import required crypto libraries
  const { createSign, createHash, randomBytes } = await import("node:crypto");
  const { URL } = await import("node:url");
  
  const endpoint = new URL(subscription.endpoint);
  const isApplePush = endpoint.hostname.includes('push.apple.com');
  
  console.log(`📱 Sending to ${isApplePush ? 'Apple' : 'FCM'} push service`);
  
  // Generate JWT for VAPID
  const header = {
    typ: "JWT",
    alg: "ES256"
  };
  
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    aud: `${endpoint.protocol}//${endpoint.hostname}`,
    exp: now + 12 * 3600, // 12 hours for iOS
    sub: vapidEmail.startsWith('mailto:') ? vapidEmail : `mailto:${vapidEmail}`
  };
  
  const jwtHeader = btoa(JSON.stringify(header)).replace(/=/g, '');
  const jwtPayload = btoa(JSON.stringify(claims)).replace(/=/g, '');
  const unsignedToken = `${jwtHeader}.${jwtPayload}`;
  
  // For iOS, we need to use the web-push library properly
  // Import web-push dynamically
  const webpush = await import("npm:web-push@3.6.7");
  
  // Set VAPID details with proper formatting
  webpush.setVapidDetails(
    claims.sub,
    vapidPublicKey,
    vapidPrivateKey
  );
  
  // iOS-specific options
  const options = {
    TTL: 2419200, // 28 days - maximum for iOS
    urgency: 'high',
    topic: 'com.navikinder.app' // Your app identifier
  };
  
  // Add iOS-specific headers if it's an Apple endpoint
  if (isApplePush) {
    Object.assign(options, {
      headers: {
        'apns-priority': '10',
        'apns-push-type': 'alert',
        'apns-expiration': '0' // Deliver immediately
      }
    });
  }
  
  try {
    // Use web-push to send the notification
    await webpush.sendNotification(
      {
        endpoint: subscription.endpoint,
        keys: {
          p256dh: subscription.p256dh,
          auth: subscription.auth
        }
      },
      payload,
      options
    );
    
    console.log(`✅ Successfully sent to ${isApplePush ? 'Apple' : 'FCM'}`);
    return { success: true, platform: isApplePush ? 'iOS' : 'Web' };
  } catch (error: any) {
    console.error(`❌ Failed to send push:`, error);
    
    // Log detailed error info for iOS debugging
    if (error.statusCode) {
      console.error(`Status Code: ${error.statusCode}`);
      console.error(`Headers:`, error.headers);
      console.error(`Body:`, error.body);
    }
    
    return { 
      success: false, 
      error: error.message,
      statusCode: error.statusCode,
      platform: isApplePush ? 'iOS' : 'Web'
    };
  }
}

const handler = async (req: Request): Promise<Response> => {
  console.log("🚀 Push notification function invoked at", new Date().toISOString());

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const vapidPublicKey = Deno.env.get("VAPID_PUBLIC_KEY")!;
    const vapidPrivateKey = Deno.env.get("VAPID_PRIVATE_KEY")!;
    const vapidEmail = Deno.env.get("VAPID_EMAIL") || "support@navikinder.com";

    console.log("📧 VAPID configured for:", vapidEmail);

    const supabase = createClient(supabaseUrl, supabaseKey);
    const requestData: PushNotificationRequest = await req.json();
    
    console.log(`📱 Processing: ${requestData.child_name}'s ${requestData.medication_name}`);

    // Find user
    let userId: string | null = null;
    
    const { data: userProfile } = await supabase
      .from("profiles")
      .select("id")
      .eq("email", requestData.parent_email)
      .single();

    if (userProfile) {
      userId = userProfile.id;
    } else {
      // Try auth users
      const { data: authData } = await supabase.auth.admin.listUsers();
      const user = authData?.users?.find(u => 
        u.email?.toLowerCase() === requestData.parent_email.toLowerCase()
      );
      userId = user?.id || null;
    }

    if (!userId) {
      return new Response(
        JSON.stringify({ error: "User not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Get subscriptions
    const { data: subscriptions } = await supabase
      .from("push_subscriptions")
      .select("*")
      .eq("user_id", userId);

    if (!subscriptions?.length) {
      return new Response(
        JSON.stringify({ message: "No subscriptions found" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`📲 Found ${subscriptions.length} subscription(s)`);

    // Create iOS-optimized payload
    const notificationPayload = {
      notification: {
        title: `💊 ${requestData.medication_name}`,
        body: `Time for ${requestData.child_name}'s medication (${requestData.dose_amount} ${requestData.dose_unit})`,
        icon: '/navikinder-logo-256.png',
        badge: '/navikinder-logo-256.png',
        sound: 'default',
      },
      data: {
        doseInstanceId: requestData.dose_instance_id,
        medicationName: requestData.medication_name,
        childName: requestData.child_name,
        timestamp: Date.now()
      },
    };

    const payloadString = JSON.stringify(notificationPayload);
    console.log('📦 Payload:', payloadString);

    // Send to all subscriptions
    const results = await Promise.all(
      subscriptions.map(sub => 
        sendWebPushNotification(
          sub,
          payloadString,
          vapidPublicKey,
          vapidPrivateKey,
          vapidEmail
        )
      )
    );

    const successCount = results.filter(r => r.success).length;
    const failureDetails = results.filter(r => !r.success);

    console.log(`📊 Results: ${successCount}/${results.length} successful`);
    
    if (failureDetails.length > 0) {
      console.log('❌ Failures:', JSON.stringify(failureDetails, null, 2));
    }

    // Clean up failed subscriptions
    for (let i = 0; i < results.length; i++) {
      if (!results[i].success && results[i].statusCode === 410) {
        await supabase
          .from("push_subscriptions")
          .delete()
          .eq("id", subscriptions[i].id);
        console.log('🗑️ Removed expired subscription');
      }
    }

    return new Response(
      JSON.stringify({
        message: "Push notifications processed",
        sent: successCount,
        failed: results.length - successCount,
        results
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error: any) {
    console.error("❌ Function error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
};

serve(handler);
