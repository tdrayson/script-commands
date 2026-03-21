#!/usr/bin/env node

// Required parameters:
// @raycast.schemaVersion 1
// @raycast.title Create Cinema Event
// @raycast.mode compact

// Optional parameters:
// @raycast.icon 🎬
// @raycast.packageName Calendar

// Documentation:
// @raycast.description Process cinema booking from cinema.md (markdown email) and add event to Calendar
// @raycast.author taylor_drayson
// @raycast.authorURL https://raycast.com/taylor_drayson

const { spawnSync } = require('child_process');
const fs = require('fs');
const https = require('https');
const path = require('path');
const { URL } = require('url');

// Configuration object for easy updates
const CONFIG = {
  distanceMatrixApiKey:
    'rrGp8wtZrdc2QamECwZw2kg5P9RM2m6mOBf76k5YSPjNGT1fmq9NZRxNNeH0XutN',
  distanceMatrixApiUrl:
    'https://api.distancematrix.ai/maps/api/distancematrix/json',
  stingerApiUrl: 'https://aftercredits.taylor-295.workers.dev/search',
  homeAddress: '22 Maywater Close, South Croydon, Surrey, CR2 0RS',
  travelTime: 45, // minutes to drive to Festival Park (fallback if API fails)
  travelBufferPercentage: 10, // percentage buffer added to travel time
  travelBufferMinutes: 0, // minimum buffer minutes added to travel time
  podcastBuffer: 35, // minutes before leaving to record podcast
  filmStartOffset: 15, // minutes after listed time when film actually starts
  postFilmBuffer: 5, // extra minutes after runtime
  calendarName: 'Taylor and Gordon',
  placeholderEvent: 'Cinema Placeholder',
  /** Markdown export path (same folder as this script) */
  cinemaMarkdownFile: 'cinema.md',
  // Dynamic eating times based on screening type
  eatingTimes: {
    '2D': 50,
    '3D': 65,
    'IMAX': 65,
    'ScreenX': 65,
    '4DX': 65,
    '4DX 3D': 65,
    'default': 50,
  },
};

// Utility functions
const utils = {
  /**
   * Cleans and normalizes text by removing HTML tags and entities
   * @param {string} inputText - The raw text to clean
   * @returns {string} The cleaned and normalized text
   */
  cleanText(inputText) {
    if (!inputText) return '';

    // Remove HTML tags and entities
    let cleaned = inputText
      .replace(/<[^>]*>/g, '') // Remove HTML tags
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/Â£/g, '£')
      .replace(/Â©/g, '©')
      .replace(/Â /g, ' ')
      .replace(/\s+/g, ' ') // Normalize whitespace
      .trim();

    return cleaned;
  },

  /**
   * Detects screen type from film title and updates screening type accordingly
   * Parses film titles for special screening types in brackets like (IMAX), (4DX), etc.
   * @param {string} movieTitle - The movie title to analyze
   * @param {string} originalScreeningType - The original screening type from booking
   * @returns {string} The detected or original screening type
   */
  detectScreenType(movieTitle, originalScreeningType) {
    if (!movieTitle || movieTitle === 'Not found') {
      return originalScreeningType;
    }

    // Look for special screening types in brackets
    const screenTypePatterns = [
      { pattern: /\(IMAX\)/i, type: 'IMAX' },
      { pattern: /\(ScreenX\)/i, type: 'ScreenX' },
      { pattern: /\(4DX\s+3D\)/i, type: '4DX 3D' },
      { pattern: /\(4DX\)/i, type: '4DX' },
      { pattern: /\(3D\)/i, type: '3D' },
    ];

    for (const { pattern, type } of screenTypePatterns) {
      if (pattern.test(movieTitle)) {
        return type;
      }
    }

    // If no special type found in title, return original screening type
    return originalScreeningType;
  },

  /**
   * Gets the appropriate eating time based on screening type
   * @param {string} screeningType - The screening type (2D, 3D, IMAX, etc.)
   * @returns {number} The eating time in minutes
   */
  getEatingTime(screeningType) {
    if (!screeningType || screeningType === 'Not found') {
      return CONFIG.eatingTimes.default;
    }

    // Check if screening type matches any configured eating time
    for (const [type, time] of Object.entries(CONFIG.eatingTimes)) {
      if (
        type !== 'default' &&
        screeningType.toLowerCase().includes(type.toLowerCase())
      ) {
        return time;
      }
    }

    return CONFIG.eatingTimes.default;
  },

  /**
   * Makes an HTTP GET request to the specified URL
   * @param {string} url - The URL to make the request to
   * @returns {Promise<Object>} The parsed JSON response
   * @throws {Error} If the request fails or response is invalid JSON
   */
  async makeRequest(url) {
    return new Promise((resolve, reject) => {
      https
        .get(url, (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            try {
              const response = JSON.parse(data);
              return resolve(response);
            } catch (error) {
              console.error('❌ Invalid JSON response:', error.message);
              return reject(new Error('Invalid JSON response'));
            }
          });
        })
        .on('error', (error) => {
          console.error('❌ API request failed:', error.message);
          return reject(error);
        });
    });
  },

  /**
   * Extracts the year from a movie title if it contains a year in parentheses
   * @param {string} movieTitle - The movie title to extract year from
   * @returns {string} The extracted year or current year as default if not found
   */
  extractYearFromTitle(movieTitle) {
    const currentYear = new Date().getFullYear().toString();

    if (!movieTitle || movieTitle === 'Not found') {
      return currentYear;
    }

    // Look for year in parentheses at the end of the title
    const yearMatch = movieTitle.match(/\((\d{4})\)\s*$/);
    return yearMatch ? yearMatch[1] : currentYear;
  },

  /**
   * Removes the year and special screening type prefixes from a movie title
   * @param {string} movieTitle - The movie title to clean
   * @returns {string} The cleaned movie title without year and screening type prefixes
   */
  cleanMovieTitle(movieTitle) {
    if (!movieTitle || movieTitle === 'Not found') {
      return movieTitle;
    }

    let cleaned = movieTitle;

    // Remove special screening type prefixes at the beginning
    const screeningTypePatterns = [
      /^\(IMAX\)\s*/i,
      /^\(ScreenX\)\s*/i,
      /^\(4DX\s+3D\)\s*/i,
      /^\(4DX\)\s*/i,
      /^\(3D\)\s*/i,
    ];

    for (const pattern of screeningTypePatterns) {
      cleaned = cleaned.replace(pattern, '');
    }

    // Remove year in parentheses at the end of the title
    cleaned = cleaned.replace(/\s*\(\d{4}\)\s*$/, '').trim();

    return cleaned;
  },

  /**
   * Fetches stinger information for a film from the Cloudflare Worker API
   * @param {string} movieTitle - The movie title to search for
   * @param {string} year - The movie year (optional, defaults to current year)
   * @returns {Promise<Object|null>} The stinger information or null if not found
   */
  async getStingerInfo(movieTitle, year = null) {
    if (!movieTitle || movieTitle === 'Not found') {
      return null;
    }

    try {
      // Always use current year if no year is provided
      const searchYear = year || new Date().getFullYear().toString();
      
      const url = new URL(CONFIG.stingerApiUrl);
      url.searchParams.set('title', movieTitle);
      url.searchParams.set('year', searchYear);

      const response = await this.makeRequest(url.toString());

      if (
        response &&
        response.found &&
        response.films &&
        response.films.length > 0
      ) {
        const searchTitle = movieTitle.toLowerCase().trim();

        // Prefer a film whose title contains the movie title (e.g. "Mercy (2026)")
        let film =
          response.films.find((f) =>
            f.title && f.title.toLowerCase().includes(searchTitle),
          ) || response.films[0];

        return {
          title: film.title,
          stingerStatus: film.stingerStatus,
          stingerTypes: film.stingerTypes || [],
          duringCredits: film.duringCredits,
          afterCredits: film.afterCredits,
          url: film.url,
        };
      }

      return null;
    } catch (error) {
      console.error('❌ Failed to fetch stinger info:', error.message);
      return null;
    }
  },

  /**
   * Formats a Date object to HH:MM time format
   * @param {Date} date - The date to format
   * @returns {string} The formatted time string (HH:MM)
   */
  formatTime(date) {
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    return `${hours}:${minutes}`;
  },

  /**
   * Formats minutes to human readable time format
   * @param {number} minutes - The number of minutes to format
   * @returns {string} Human readable time (e.g., "1 hour 30 minutes", "45 minutes")
   */
  formatTimeHumanReadable(minutes) {
    if (minutes < 1) {
      return 'less than 1 minute';
    }

    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;

    if (hours === 0) {
      return `${minutes} minute${minutes !== 1 ? 's' : ''}`;
    } else if (remainingMinutes === 0) {
      return `${hours} hour${hours !== 1 ? 's' : ''}`;
    } else {
      return `${hours} hour${
        hours !== 1 ? 's' : ''
      } ${remainingMinutes} minute${remainingMinutes !== 1 ? 's' : ''}`;
    }
  },
};

// Booking details extraction
const bookingExtractor = {
  escapeRegex(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  },

  /**
   * Converts Cineworld-style markdown email export to plain text the field parser expects.
   * Handles [label](url), _italic titles_, and Label:** value** lines.
   * @param {string} md - Raw markdown
   * @returns {string} Normalized text
   */
  normalizeMarkdownForBooking(md) {
    if (!md) return '';

    let s = md.trim();
    // Raycast / mail markdown: drop headers above first --- (avoids **Date:** email sent time vs booking Date:)
    const headerSplit = s.split(/\n---\s*\n/);
    if (headerSplit.length > 1) {
      s = headerSplit.slice(1).join('\n---\n').trim();
    }

    // Markdown links → visible text only
    s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
    // Italic _title_ (Cineworld puts film name after the "You are going to see:" link)
    s = s.replace(/(^|[\s:])_([^_\n]+?)_/g, '$1$2');
    // Cineworld: Field:** value** → Field: value
    s = s.replace(/^([^:\n]+):\*\*\s*([^*\n]*?)\*\*/gm, '$1: $2');
    // Remove any remaining bold markers
    s = s.replace(/\*\*/g, '');
    return s.trim();
  },

  /**
   * Extracts a field value from booking content between start and end markers
   * @param {string} content - The full booking content to search in
   * @param {string} startField - The start marker for the field
   * @param {string} endField - The end marker for the field (optional)
   * @returns {string} The extracted field value or 'Not found' if not found
   */
  extractField(content, startField, endField) {
    if (!content || !startField) return 'Not found';

    if (!endField || endField === '') {
      // Extract from start field to end of content or next field
      if (startField.includes('Seat(s):')) {
        // Special handling for seat numbers - extract just the seat code
        const regex = /Seat\(s\):\s*([^\s]+)/;
        const match = content.match(regex);
        if (!match || !match[1]) return 'Not found';
        return match[1].trim();
      } else {
        // For other fields, extract to next field or end
        const escapedStart = this.escapeRegex(startField);
        const regex = new RegExp(
          `${escapedStart}\\s*([^\\n]*?)(?=\\s*[A-Z][a-z]+:|$)`,
          's',
        );
        const match = content.match(regex);
        if (!match || !match[1]) return 'Not found';
        return match[1].trim();
      }
    }

    // Look for the field between start and end markers (may span lines, e.g. markdown export)
    const escapedStart = this.escapeRegex(startField);
    const escapedEnd = this.escapeRegex(endField);
    const regex = new RegExp(
      `${escapedStart}\\s*([\\s\\S]*?)\\s*${escapedEnd}`,
    );
    const match = content.match(regex);

    if (!match || !match[1]) return 'Not found';

    return match[1].trim();
  },

  /**
   * Extracts all booking details from the booking content
   * @param {string} bookingContent - Normalized booking text (from cinema.md)
   * @returns {Object} Object containing all extracted booking details
   * @throws {Error} If no booking content is provided
   */
  extractBookingDetails(bookingContent) {
    if (!bookingContent) {
      throw new Error('No booking content provided');
    }

    const fields = [
      {
        key: 'movieTitle',
        start: 'You are going to see:',
        end: 'Certification:',
      },
      { key: 'certification', start: 'Certification:', end: 'Running time:' },
      {
        key: 'runningTime',
        start: 'Running time:',
        end: 'Booking reference number:',
      },
      {
        key: 'bookingReference',
        start: 'Booking reference number:',
        end: 'Date:',
      },
      { key: 'dateValue', start: 'Date:', end: 'Cinema:' },
      { key: 'cinema', start: 'Cinema:', end: 'Cinema address:' },
      {
        key: 'cinemaAddress',
        start: 'Cinema address:',
        end: 'Screening type:',
      },
      { key: 'screeningType', start: 'Screening type:', end: 'Screen:' },
      { key: 'screenNumber', start: 'Screen:', end: 'Number of people going:' },
      {
        key: 'numberOfPeople',
        start: 'Number of people going:',
        end: 'Seat(s):',
      },
      { key: 'seatNumbers', start: 'Seat(s):', end: 'Use your e-ticket' },
    ];

    const details = {};
    fields.forEach((field) => {
      let value = this.extractField(bookingContent, field.start, field.end);

      // Try alternative field names for problematic fields
      if (field.key === 'numberOfPeople' && value === 'Not found') {
        // Try alternative field names for number of people
        const alternatives = [
          'Number of people:',
          'People:',
          'Attendees:',
          'Guests:',
        ];
        for (const alt of alternatives) {
          value = this.extractField(bookingContent, alt, 'Seat(s):');
          if (value !== 'Not found') break;
        }

        // If still not found, try a direct regex match
        if (value === 'Not found') {
          const match = bookingContent.match(/Number of people going:\s*(\d+)/);
          if (match) {
            value = match[1];
          }
        }
      }

      if (field.key === 'seatNumbers' && value === 'Not found') {
        // Try alternative field names for seats
        const alternatives = [
          'Seat:',
          'Seats:',
          'Seat numbers:',
          'Seat number:',
        ];
        for (const alt of alternatives) {
          value = this.extractField(bookingContent, alt, '');
          if (value !== 'Not found') break;
        }

        // If still not found, try a direct regex match
        if (value === 'Not found') {
          const match = bookingContent.match(/Seat\(s\):\s*([^\s]+)/);
          if (match) {
            value = match[1];
          }
        }
      }

      details[field.key] = value;
    });

    return details;
  },

  /**
   * Extracts running time in minutes from the running time string
   * @param {string} runningTime - The running time string (e.g., "120 minutes")
   * @returns {number} The running time in minutes (defaults to 120 if parsing fails)
   */
  extractRunningTimeMinutes(runningTime) {
    if (!runningTime || runningTime === 'Not found') return 120;

    const match = runningTime.match(/\b(\d+)\b/);
    const minutes = match ? parseInt(match[1], 10) : 120;
    return minutes;
  },

  /**
   * Extracts and calculates event start and end dates from booking date and running time
   * @param {string} dateValue - The date string from booking (format: "DD/MM/YYYY HH:MM")
   * @param {number} runningTimeMinutes - The film running time in minutes
   * @returns {Object} Object containing startDate and endDate Date objects
   * @throws {Error} If date format is invalid
   */
  extractEventDates(dateValue, runningTimeMinutes) {
    if (!dateValue || dateValue === 'Not found') {
      throw new Error('Invalid date format');
    }

    // Parse date format like "25/12/2024 19:30"
    const dateMatch = dateValue.match(/(\d+)\/(\d+)\/(\d+)\s+(\d+):(\d+)/);

    if (!dateMatch) {
      throw new Error('Invalid date format');
    }

    const [, day, month, year, hour, minute] = dateMatch;

    const startDate = new Date(year, month - 1, day, hour, minute);

    // Add film start offset
    const adjustedStart = new Date(
      startDate.getTime() + CONFIG.filmStartOffset * 60 * 1000,
    );

    // Calculate end time
    const endDate = new Date(
      adjustedStart.getTime() +
        (runningTimeMinutes + CONFIG.postFilmBuffer) * 60 * 1000,
    );

    return { startDate: adjustedStart, endDate };
  },
};

// Travel time calculation using distancematrix.ai API
const travelCalculator = {
  /**
   * Gets travel time with arrival time using the distancematrix.ai API
   * @param {string} origin - The origin address
   * @param {string} destination - The destination address
   * @param {number} arrivalTime - The arrival time as Unix timestamp
   * @returns {Promise<number>} The travel time in minutes
   */
  async getTravelTimeWithArrivalTime(origin, destination, arrivalTime) {
    if (
      !origin ||
      !destination ||
      !arrivalTime ||
      !CONFIG.distanceMatrixApiKey
    ) {
      return CONFIG.travelTime;
    }

    try {
      const url = new URL(CONFIG.distanceMatrixApiUrl);
      url.searchParams.set('origins', origin);
      url.searchParams.set('destinations', destination);
      url.searchParams.set('arrival_time', arrivalTime);
      url.searchParams.set('key', CONFIG.distanceMatrixApiKey);

      const response = await utils.makeRequest(url.toString());

      if (
        response.rows &&
        response.rows.length > 0 &&
        response.rows[0].elements &&
        response.rows[0].elements.length > 0
      ) {
        const element = response.rows[0].elements[0];

        if (element.status === 'OK' && element.duration_in_traffic) {
          // Convert seconds to minutes
          const minutes = Math.round(element.duration_in_traffic.value / 60);
          return minutes;
        } else if (element.status === 'OK' && element.duration) {
          // Fallback to duration if duration_in_traffic is not available
          const minutes = Math.round(element.duration.value / 60);
          return minutes;
        }
      }

      return CONFIG.travelTime;
    } catch (error) {
      console.error(
        '❌ Failed to get travel time from distancematrix.ai:',
        error.message,
      );
      return CONFIG.travelTime;
    }
  },

  /**
   * Calculates the actual travel time including buffer time
   * @param {string} cinemaAddress - The cinema address
   * @param {Date} eventStartTime - The event start time
   * @returns {Promise<number>} The total travel time including buffer in minutes
   */
  async getActualTravelTime(cinemaAddress, eventStartTime) {
    if (!cinemaAddress || cinemaAddress === 'Not found') {
      return CONFIG.travelTime;
    }

    try {
      // Format arrival time as Unix timestamp
      const arrivalTimestamp = Math.floor(eventStartTime.getTime() / 1000);

      const travelTime = await this.getTravelTimeWithArrivalTime(
        CONFIG.homeAddress,
        cinemaAddress,
        arrivalTimestamp,
      );

      // Add travel buffer
      const percentageBuffer = Math.round(
        (travelTime * CONFIG.travelBufferPercentage) / 100,
      );
      const travelBuffer = Math.max(
        percentageBuffer,
        CONFIG.travelBufferMinutes,
      );

      const totalTravelTime = travelTime + travelBuffer;

      return totalTravelTime;
    } catch (error) {
      console.error('❌ Failed to calculate travel time:', error.message);
      return CONFIG.travelTime;
    }
  },
};

/**
 * Run AppleScript without invoking the shell (avoids breakage when titles contain apostrophes, e.g. Mother's Pride).
 * @param {string} script
 */
function runAppleScript(script) {
  const result = spawnSync('osascript', ['-e', script.trim()], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const errText = (result.stderr || result.stdout || '').trim();
    throw new Error(errText || `osascript exited with code ${result.status}`);
  }
}

// Calendar integration
const calendarManager = {
  /**
   * Gets the next episode number from the podcast API
   * @returns {Promise<string>} The next episode number or 'XXX' if failed
   */
  async getNextEpisodeNumber() {
    try {
      const response = await utils.makeRequest(
        'https://www.thisweekwith.co.uk/wp-json/api/v1/next-episode',
      );
      const episodeNumber = response.toString().trim();
      return episodeNumber;
    } catch (error) {
      console.error('❌ Failed to get episode number:', error.message);
      return 'XXX';
    }
  },

  /**
   * Adds an event to the specified calendar using AppleScript
   * @param {string} calendarName - The name of the calendar to add the event to
   * @param {string} eventTitle - The title of the event
   * @param {string} description - The event description
   * @param {string} location - The event location
   * @param {Date} startDate - The event start date
   * @param {Date} endDate - The event end date
   * @param {number} bufferMinutes - The buffer time in minutes (negative for alarm)
   * @returns {boolean} True if successful, false otherwise
   */
  addEventToCalendar(
    calendarName,
    eventTitle,
    description,
    location,
    startDate,
    endDate,
    bufferMinutes,
  ) {
    try {
      // Create calendar event using AppleScript
      const locationParam =
        location && location !== 'Not found' && location.trim() !== ''
          ? `location:"${location}"`
          : '';
      const alarmMinutes = -bufferMinutes;

      // Format dates for AppleScript (matching the original AppleScript format)
      const formatDateForAppleScript = (date) => {
        const day = date.getDate().toString().padStart(2, '0');
        const month = (date.getMonth() + 1).toString().padStart(2, '0');
        const year = date.getFullYear();
        const hours = date.getHours().toString().padStart(2, '0');
        const minutes = date.getMinutes().toString().padStart(2, '0');
        const seconds = date.getSeconds().toString().padStart(2, '0');
        const formattedDate = `${day}/${month}/${year} ${hours}:${minutes}:${seconds}`;
        return formattedDate;
      };

      const startDateFormatted = formatDateForAppleScript(startDate);
      const endDateFormatted = formatDateForAppleScript(endDate);

      const script = `
        tell application "Calendar"
          set startDate to date "${startDateFormatted}"
          set endDate to date "${endDateFormatted}"
          set newEvent to make new event at end of events of calendar "${calendarName}" with properties {description:"${description.replace(
            /"/g,
            '\\"',
          )}", summary:"${eventTitle.replace(/"/g, '\\"')}"${
            locationParam ? ', ' + locationParam : ''
          }, start date:startDate, end date:endDate}
          tell newEvent
            make new display alarm at end with properties {trigger interval:${alarmMinutes}}
          end tell
        end tell
      `;

      runAppleScript(script);
      return true;
    } catch (error) {
      console.error('❌ Failed to add event to calendar:', error.message);
      return false;
    }
  },

  /**
   * Deletes a placeholder event from the specified calendar
   * @param {string} calendarName - The name of the calendar
   * @param {string} placeholderEvent - The placeholder event title to delete
   * @param {Date} startDate - The start date to match for deletion
   * @returns {boolean} True if successful, false otherwise
   */
  deletePlaceholderEvent(calendarName, placeholderEvent, startDate) {
    try {
      // Format date for AppleScript (local time)
      const formatDateForAppleScript = (date) => {
        const day = date.getDate().toString().padStart(2, '0');
        const month = (date.getMonth() + 1).toString().padStart(2, '0');
        const year = date.getFullYear();
        const hours = date.getHours().toString().padStart(2, '0');
        const minutes = date.getMinutes().toString().padStart(2, '0');
        const seconds = date.getSeconds().toString().padStart(2, '0');
        return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
      };

      const startDateFormatted = formatDateForAppleScript(startDate);

      const script = `
        tell application "Calendar"
          set targetDate to date "${startDateFormatted}"
          set targetEvents to (every event of calendar "${calendarName}" whose summary is "${placeholderEvent}")
          repeat with eventItem in targetEvents
            if start date of eventItem = targetDate then
              delete eventItem
            end if
          end repeat
        end tell
      `;

      runAppleScript(script);
      return true;
    } catch (error) {
      console.error('❌ Failed to delete placeholder event:', error.message);
      return false;
    }
  },
};

/**
 * Main processing function that handles the entire booking workflow
 * Extracts booking details, calculates timing, and creates calendar events
 * @param {string} bookingContent - Normalized booking text (from cinema.md)
 * @throws {Error} If essential booking information is missing or invalid
 */
async function processBooking(bookingContent) {
  try {
    // Extract booking details
    const bookingDetails =
      bookingExtractor.extractBookingDetails(bookingContent);
    const {
      movieTitle,
      certification,
      runningTime,
      bookingReference,
      dateValue,
      cinema,
      cinemaAddress,
      screeningType,
      screenNumber,
      numberOfPeople,
      seatNumbers,
    } = bookingDetails;

    // Validate essential details
    if (movieTitle === 'Not found' || dateValue === 'Not found') {
      throw new Error(
        'Invalid Booking Information: Unable to process the booking. Essential information is missing.',
      );
    }

    // Get running time
    const runningTimeMinutes =
      bookingExtractor.extractRunningTimeMinutes(runningTime);

    // Extract event dates
    const { startDate, endDate } = bookingExtractor.extractEventDates(
      dateValue,
      runningTimeMinutes,
    );

    // Detect and update screening type based on film title
    const detectedScreeningType = utils.detectScreenType(
      movieTitle,
      screeningType,
    );

    // Get eating time based on screening type
    const eatingTime = utils.getEatingTime(detectedScreeningType);

    // Calculate travel time
    const actualTravelTime = await travelCalculator.getActualTravelTime(
      cinemaAddress,
      startDate,
    );

    // Fetch stinger information
    const cleanTitle = utils.cleanMovieTitle(movieTitle);
    const extractedYear = utils.extractYearFromTitle(movieTitle);
    const stingerInfo = await utils.getStingerInfo(cleanTitle, extractedYear);

    // Calculate timing
    const totalPreEventBuffer = (actualTravelTime + eatingTime) * 60 * 1000; // Convert to milliseconds
    const timeToLeave = new Date(startDate.getTime() - totalPreEventBuffer);
    const podcastStart = new Date(
      timeToLeave.getTime() - CONFIG.podcastBuffer * 60 * 1000,
    );
    const podcastEnd = timeToLeave;

    // Build description - reorganized for mobile viewing priority
    const seatLabel = numberOfPeople === '1' ? 'Seat: ' : 'Seats: ';
    const timeToLeaveFormatted = utils.formatTime(timeToLeave);

    let description = `TIMING:\n`;
    description += `Time to leave: ${timeToLeaveFormatted}\n`;
    description += `Travel time: ${utils.formatTimeHumanReadable(
      actualTravelTime,
    )}\n\n`;

    description += `SCREENING DETAILS:\n`;
    description += `${seatLabel}${seatNumbers}\n`;
    description += `Screen: ${screenNumber}\n`;
    description += `Screening type: ${detectedScreeningType}\n`;
    description += `Running time: ${runningTime}\n`;
    description += `Certification: ${certification}\n\n`;

    // Add stinger information if available
    if (stingerInfo) {
      description += `STINGER DETAILS:\n`;
      description += `Status: ${stingerInfo.stingerStatus}\n`;
      if (
        stingerInfo.duringCredits &&
        stingerInfo.duringCredits !== 'Unknown'
      ) {
        description += `During Credits: ${stingerInfo.duringCredits}\n`;
      }
      if (stingerInfo.afterCredits && stingerInfo.afterCredits !== 'Unknown') {
        description += `After Credits: ${stingerInfo.afterCredits}\n`;
      }
      if (stingerInfo.stingerTypes && stingerInfo.stingerTypes.length > 0) {
        description += `Types: ${stingerInfo.stingerTypes.join(', ')}\n`;
      }
      description += `More info: ${stingerInfo.url}\n\n`;
    }

    description += `BOOKING DETAILS:\n`;
    description += `Booking reference: ${bookingReference}\n`;
    description += `Cinema: ${cinema}\n`;
    description += `Address: ${cinemaAddress}\n`;
    description += `Date: ${dateValue}\n`;
    description += `People: ${numberOfPeople}`;

    const eventTitle = `Cinema: ${movieTitle}`;

    // Add podcast event
    const episodeNumber = await calendarManager.getNextEpisodeNumber();
    const podcastTitle = `Film "This Week With" E${episodeNumber}`;
    calendarManager.addEventToCalendar(
      CONFIG.calendarName,
      podcastTitle,
      `Film podcast recording before ${movieTitle}`,
      '',
      podcastStart,
      podcastEnd,
      0,
    );

    // Add cinema event
    const totalBufferMinutes = actualTravelTime + eatingTime;
    calendarManager.addEventToCalendar(
      CONFIG.calendarName,
      eventTitle,
      description,
      cinemaAddress,
      startDate,
      endDate,
      totalBufferMinutes,
    );

    // Delete placeholder event
    calendarManager.deletePlaceholderEvent(
      CONFIG.calendarName,
      CONFIG.placeholderEvent,
      startDate,
    );
  } catch (error) {
    console.error('❌ Error processing booking:', error.message);
    process.exit(1);
  }
}

/**
 * Main execution function that orchestrates the entire script workflow
 * Reads cinema.md next to this script, normalizes markdown, and processes the booking
 * @throws {Error} If cinema.md is missing, empty, or processing fails
 */
async function main() {
  try {
    const cinemaPath = path.join(__dirname, CONFIG.cinemaMarkdownFile);

    if (!fs.existsSync(cinemaPath)) {
      console.error(
        `❌ ${CONFIG.cinemaMarkdownFile} not found next to script:\n   ${cinemaPath}`,
      );
      process.exit(1);
    }

    const rawMarkdown = fs.readFileSync(cinemaPath, 'utf8');
    const normalizedMarkdown =
      bookingExtractor.normalizeMarkdownForBooking(rawMarkdown);
    const cleanedContent = utils.cleanText(normalizedMarkdown);

    if (!cleanedContent || cleanedContent.trim().length === 0) {
      console.error(`❌ No usable content in ${CONFIG.cinemaMarkdownFile}`);
      process.exit(1);
    }

    await processBooking(cleanedContent);
  } catch (error) {
    console.error('❌ Failed to process booking:', error.message);
    process.exit(1);
  }
}

// Run the script
if (require.main === module) {
  main();
}
