import { google } from "googleapis";
import dotenv from "dotenv";

dotenv.config();

export async function checkCalendarAvailability(timeMin, timeMax) {
  try {
    // Initialize Google Calendar API with service account credentials
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
    });

    const calendar = google.calendar({ version: "v3", auth });

    // Hardcode the calendarId
    const hardcodedCalendarId = process.env.GOOGLE_CALENDAR_EMAIL;

    // Get busy times from calendar
    const response = await calendar.freebusy.query({
      requestBody: {
        timeMin: timeMin || new Date().toISOString(),
        timeMax:
          timeMax || new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24 hours from now
        items: [{ id: hardcodedCalendarId }],
      },
    });

    const busyTimes = response.data.calendars[hardcodedCalendarId].busy || [];

    // Find free time slots (simplified logic)
    const freeSlots = [];
    let currentTime = new Date(timeMin || new Date());
    const endTime = new Date(
      timeMax || new Date(Date.now() + 24 * 60 * 60 * 1000)
    );

    for (const busy of busyTimes) {
      const busyStart = new Date(busy.start);
      const busyEnd = new Date(busy.end);

      // If there's a gap before this busy period, it's free
      if (currentTime < busyStart) {
        freeSlots.push({
          start: currentTime.toISOString(),
          end: busyStart.toISOString(),
        });
      }

      currentTime = busyEnd;
    }

    // Add remaining time after last busy period
    if (currentTime < endTime) {
      freeSlots.push({
        start: currentTime.toISOString(),
        end: endTime.toISOString(),
      });
    }

    return {
      busy: busyTimes,
      free: freeSlots,
    };
  } catch (error) {
    console.error("Error checking calendar availability:", error);
    return { error: error.message };
  }
}

// const now = new Date();
// const threeDaysLater = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
// const result = await checkCalendarAvailability(
//   now.toISOString(),
//   threeDaysLater.toISOString()
// );
// console.log(result.free);
