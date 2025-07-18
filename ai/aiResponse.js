import { setTimeout as wait } from "node:timers/promises";
import { OpenAI } from "openai";
import { google } from "googleapis";
import fs from "fs";
import {
  formattedCalendarAvailability,
  scheduleMeeting,
} from "../calendar/gCalendar.js";
import { upsertUserData } from "../db.js";
import { DateTime } from "luxon";
import isEqual from "lodash.isequal";
import { minimalCalendarAvailability } from "../routes/sendMessage.js";

export const openai = new OpenAI({ apiKey: process.env.OPENAI_KEY });

// Helper function to get the key file path from env (supports raw JSON or file path)
function getKeyFilePath() {
  const keyEnv = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyEnv)
    throw new Error(
      "Missing GOOGLE_SERVICE_ACCOUNT_KEY in environment variables"
    );
  // If it looks like a JSON object, write to a temp file
  if (keyEnv.trim().startsWith("{")) {
    const tempPath = "./.google-service-account.temp.json";
    fs.writeFileSync(tempPath, keyEnv);
    return tempPath;
  }
  // Otherwise, treat as file path
  return keyEnv;
}

// Helper function to upsert a row to Google Sheets (update if exists, insert if not)
async function upsertToGoogleSheet(userData, userId) {
  const KEYFILEPATH = getKeyFilePath();
  const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;
  const SHEET_NAME = "Chatbot";

  if (!SPREADSHEET_ID)
    throw new Error("Missing GOOGLE_SHEET_ID in environment variables");

  try {
    const auth = new google.auth.GoogleAuth({
      keyFile: KEYFILEPATH,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    const sheets = google.sheets({ version: "v4", auth });

    // First, get all existing data to check for duplicates
    const existingData = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A:Z`,
    });

    const rows = existingData.data.values || [];
    let rowIndex = -1;

    // Find existing row by userId (column K, index 10)
    if (rows.length > 0) {
      for (let i = 0; i < rows.length; i++) {
        if (rows[i][10] === userId) {
          // userId is in column K (index 10)
          rowIndex = i + 1; // Google Sheets is 1-indexed
          break;
        }
      }
    }

    const newRow = [
      userData.name || "",
      userData.email || "",
      userData.reason || "",
      userData.appointment_date || "",
      userData.appointment_time || "",
      new Date().toISOString(),
      userData.location || "",
      userData.utc || "",
      JSON.stringify(userData.calendar_availability || ""),
      userData.colleague || "",
      userId || "",
      userData.appointment_booked || "",
      JSON.stringify(userData) || "",
    ];

    if (rowIndex > 0) {
      // Update existing row
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_NAME}!A${rowIndex}:Z${rowIndex}`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [newRow] },
      });
    } else {
      // Append new row
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_NAME}!A:Z`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [newRow] },
      });
    }
  } finally {
    // Clean up temp file if it was created
    if (
      KEYFILEPATH === "./.google-service-account.temp.json" &&
      fs.existsSync(KEYFILEPATH)
    ) {
      try {
        fs.unlinkSync(KEYFILEPATH);
      } catch (e) {
        console.warn("Failed to clean up temp file:", e.message);
      }
    }
  }
}

// Helper to book an appointment in Google Calendar
async function bookAppointment(userData) {
  // Assume appointment_date is 'YYYY-MM-DD' and appointment_time is 'HH:mm' (24-hour)
  const dateStr = userData.appointment_date; // e.g., '2025-07-18'
  const timeStr = userData.appointment_time; // e.g., '14:30'
  const timeZone = process.env.TIME_ZONE || "UTC"; // e.g., 'Europe/Riga'

  // Combine date and time in the specified time zone
  const startDate = DateTime.fromISO(`${dateStr}T${timeStr}`, {
    zone: timeZone,
  });
  const durationMinutes = parseInt(process.env.MEETING_DURATION, 10) || 60;
  const endDate = startDate.plus({ minutes: durationMinutes });

  // Build a human-friendly description
  const description = `Name: ${userData.name || "N/A"}\nEmail: ${
    userData.email || "N/A"
  }\nReason: ${userData.reason || "N/A"}\nDate: ${
    userData.appointment_date || "N/A"
  }\nTime: ${userData.appointment_time || "N/A"}\nLocation: ${
    userData.location || "N/A"
  }`;

  // Set location if available
  const location = userData.location || undefined;
  const attendees = userData.email ? [{ email: userData.email }] : [];

  const result = await scheduleMeeting({
    start: startDate.toISO(), // ISO string with correct time zone offset
    end: endDate.toISO(),
    summary: `${userData.reason || "N/A"}`,
    description,
    attendees,
    ...(location ? { location } : {}),
    timeZone, // Not used by scheduleMeeting, but kept for possible future use
  });

  if (!result.error) {
    userData.appointment_booked = true;
    userData.appointment_verified = false;
    userData.message = `The meeting has been successfully scheduled at ${userData.appointment_date}, ${userData.appointment_time}.`;
    console.log("MEETING BOOKED");
  } else {
    userData.appointment_booked = false;
    userData.appointment_verified = false;
    userData.message =
      "I'm sorry, but the meeting failed to schedule. Please book the meeting manually at https://cal.com/setinbound/ai-receptionist-demo or try again later.";
    console.log("Failed to book meeting:", result.error);
  }
  return result;
}

export async function aiResponse(openai, messages, selectedModel, userId) {
  let retries = 2;
  let delay = 5000;
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      const response = await openai.chat.completions.create({
        model: selectedModel,
        messages: messages,
        max_tokens: 1000, // Ensure enough tokens to complete JSON response
      });
      const content = response.choices?.[0]?.message?.content || "";
      let userData;
      try {
        userData = JSON.parse(content);
      } catch (e) {
        console.error(
          "[aiResponse] Failed to parse JSON from AI response:",
          e.message,
          content
        );
        return {
          response,
          message: userData && userData.message ? userData.message : null,
        };
      }
      // Update Google Availability
      if (userData && userData.utc) {
        let days = userData.days || 1;
        let prevMinimal = null;
        let minimal = null;
        let raw = null;
        let maxDays = 14; // Prevent infinite loop
        while (days <= maxDays) {
          try {
            raw = await formattedCalendarAvailability(userData.utc, days);
            minimal = minimalCalendarAvailability(raw);
          } catch (calErr) {
            console.error(
              "[aiResponse] Error in formattedCalendarAvailability:",
              calErr
            );
            break;
          }
          if (prevMinimal && !isEqual(minimal, prevMinimal)) {
            // Found a new result, break
            break;
          }
          // On first run or if same, increment days and continue
          prevMinimal = minimal;
          days++;
        }
        userData.days = days;
        userData.calendar_availability = raw;
        console.log(
          "[aiResponse] Final days used for unique calendar availability:",
          days
        );
      }
      // Book meeting
      if (
        userData &&
        userData.appointment_verified &&
        !userData.appointment_booked
      ) {
        console.log("BOOKING userData: ", userData);
        try {
          await bookAppointment(userData);
        } catch (bookErr) {
          console.error("[aiResponse] Error booking appointment:", bookErr);
        }
      }
      // Update Google Sheets
      if (userData) {
        try {
          await upsertToGoogleSheet(userData, userId);
        } catch (err) {
          console.error("[aiResponse] Failed to upsert to Google Sheet.", err);
        }
      }
      // Update neon DB
      if (userData) {
        try {
          await upsertUserData(userId, userData);
        } catch (err) {
          console.error("[aiResponse] Failed to upsert to Neon DB.", err);
        }
      }
      console.log("AFTER userData: ", userData);
      return { response, message: userData.message };
    } catch (err) {
      if (err.status === 429 && attempt <= retries) {
        console.warn(
          `[aiResponse] Rate limit hit (attempt ${attempt}). Retrying in ${
            delay / 1000
          }s...`
        );
        await wait(delay);
        delay *= 2;
      } else {
        console.error(
          "[aiResponse] OpenAI or other error:",
          err && err.stack ? err.stack : err
        );
        return { response: null, message: null };
      }
    }
  }
}
