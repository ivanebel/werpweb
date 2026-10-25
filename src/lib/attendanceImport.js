'use strict';

const { assignmentForDate, shiftWorksOn } = require('./attendance');

const MAX_EMPLOYEES = 500;
const MAX_PUNCHES = 50000;
const MAX_RANGE_DAYS = 366;

function isISODate(value) {
  const raw = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) && !Number.isNaN(new Date(`${raw}T00:00:00Z`).getTime());
}

function normalizeTime(value) {
  const match = String(value === undefined || value === null ? '' : value).trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3] || 0);
  if (hours > 23 || minutes > 59 || seconds > 59) return null;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function dateRange(dateFrom, dateTo) {
  const days = [];
  const start = new Date(`${dateFrom}T00:00:00Z`);
  const end = new Date(`${dateTo}T00:00:00Z`);
  for (let cursor = start; cursor.getTime() <= end.getTime(); cursor = new Date(cursor.getTime() + 86400000)) {
    days.push(cursor.toISOString().slice(0, 10));
  }
  return days;
}

function rangeLength(dateFrom, dateTo) {
  if (!isISODate(dateFrom) || !isISODate(dateTo)) return 0;
  return Math.round((new Date(`${dateTo}T00:00:00Z`).getTime() - new Date(`${dateFrom}T00:00:00Z`).getTime()) / 86400000) + 1;
}

/**
 * Validates and normalizes a time-clock JSON file. The employee_id in the file
 * is the clock identifier; matching it to a software employee happens later.
 */
function parseAttendanceFile(payload) {
  const errors = [];
  const warnings = [];
  const empty = { dateFrom: null, dateTo: null, employees: [], errors, warnings, totalPunches: 0 };

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    errors.push('The file must contain a JSON object.');
    return empty;
  }

  const dateFrom = String(payload.date_from || '').slice(0, 10);
  const dateTo = String(payload.date_to || '').slice(0, 10);
  if (!isISODate(dateFrom)) errors.push('date_from is required and must be a valid date (YYYY-MM-DD).');
  if (!isISODate(dateTo)) errors.push('date_to is required and must be a valid date (YYYY-MM-DD).');
  if (isISODate(dateFrom) && isISODate(dateTo)) {
    if (dateFrom > dateTo) errors.push('date_from cannot be after date_to.');
    const length = rangeLength(dateFrom, dateTo);
    if (length > MAX_RANGE_DAYS) errors.push(`The date range cannot exceed ${MAX_RANGE_DAYS} days.`);
  }

  if (!Array.isArray(payload.employees)) {
    errors.push('The file must contain an employees array.');
    return { ...empty, dateFrom, dateTo };
  }
  if (payload.employees.length > MAX_EMPLOYEES) {
    errors.push(`The file contains too many employees (maximum ${MAX_EMPLOYEES}).`);
  }

  const employees = [];
  const seenClockIds = new Set();
  let totalPunches = 0;

  payload.employees.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`Employee #${index + 1} is not a valid object.`);
      return;
    }
    const clockId = String(entry.employee_id === undefined || entry.employee_id === null ? '' : entry.employee_id).trim();
    if (!clockId) {
      errors.push(`Employee #${index + 1} has no employee_id (Clock ID).`);
      return;
    }
    if (clockId.length > 40) {
      errors.push(`Employee #${index + 1}: the Clock ID cannot exceed 40 characters.`);
      return;
    }
    if (seenClockIds.has(clockId.toLowerCase())) {
      errors.push(`Clock ID ${clockId} appears more than once in the file.`);
      return;
    }
    seenClockIds.add(clockId.toLowerCase());

    const name = String(entry.employee_name || '').trim().slice(0, 120) || null;
    const rawRecords = entry.records && typeof entry.records === 'object' && !Array.isArray(entry.records)
      ? entry.records
      : {};
    const records = {};
    let punchCount = 0;

    for (const [rawDate, day] of Object.entries(rawRecords)) {
      const date = String(rawDate || '').slice(0, 10);
      if (!isISODate(date)) {
        warnings.push(`Employee ${clockId}: ignored invalid record date "${rawDate}".`);
        continue;
      }
      if (isISODate(dateFrom) && isISODate(dateTo) && (date < dateFrom || date > dateTo)) {
        warnings.push(`Employee ${clockId}: ignored ${date} because it is outside the file date range.`);
        continue;
      }
      const list = day && Array.isArray(day.daily_record) ? day.daily_record : [];
      if (!list.length) {
        warnings.push(`Employee ${clockId}: ignored ${date} because daily_record is missing or empty.`);
        continue;
      }
      const times = [];
      for (const rawTime of list) {
        const time = normalizeTime(rawTime);
        if (!time) {
          warnings.push(`Employee ${clockId}: ignored invalid time "${rawTime}" on ${date}.`);
          continue;
        }
        times.push(time);
      }
      if (!times.length) continue;
      times.sort();
      records[date] = times;
      punchCount += times.length;
    }

    totalPunches += punchCount;
    if (!punchCount) {
      warnings.push(`Employee ${clockId}: no valid clock records in the file.`);
    }
    employees.push({
      clockId,
      name,
      records,
      punchCount,
      dayCount: Object.keys(records).length,
    });
  });

  if (totalPunches > MAX_PUNCHES) {
    errors.push(`The file contains too many clock punches (maximum ${MAX_PUNCHES}).`);
  }

  return { dateFrom, dateTo, employees, errors, warnings, totalPunches };
}

function emptyStats() {
  return {
    employeesInFile: 0,
    matchedCount: 0,
    unmatchedCount: 0,
    inactiveCount: 0,
    missingCount: 0,
    totalPunches: 0,
    daysWithRecords: 0,
    incompleteDays: 0,
    recordsToWrite: 0,
    existingToOverwrite: 0,
    missingScheduledDays: 0,
    days: 0,
  };
}

/**
 * Matches parsed clock employees to software employees and builds a compact
 * picture of what the import will write. Existing records are identified by
 * the `employeeId:date` keys supplied by the caller.
 */
function planAttendanceImport({ parsed, employees, assignmentsByEmployee, existingKeys }) {
  const stats = emptyStats();
  stats.employeesInFile = parsed.employees.length;
  stats.totalPunches = parsed.totalPunches;
  stats.days = rangeLength(parsed.dateFrom, parsed.dateTo);
  stats.dateFrom = parsed.dateFrom;
  stats.dateTo = parsed.dateTo;

  const clockKey = (value) => String(value === undefined || value === null ? '' : value).trim().toLowerCase();
  const dbByClock = new Map();
  for (const employee of employees || []) {
    if (employee.clock_id !== null && employee.clock_id !== undefined && String(employee.clock_id).trim()) {
      dbByClock.set(clockKey(employee.clock_id), employee);
    }
  }

  const fileClockIds = new Set(parsed.employees.map((employee) => clockKey(employee.clockId)));
  const matched = [];
  const unmatched = [];
  const inactive = [];

  for (const fileEmployee of parsed.employees) {
    const employee = dbByClock.get(clockKey(fileEmployee.clockId));
    if (!employee) {
      unmatched.push(fileEmployee);
    } else if (employee.status === 'inactive') {
      inactive.push({ ...fileEmployee, employee });
    } else {
      matched.push({ ...fileEmployee, employee });
    }
  }

  const missing = (employees || []).filter((employee) => (
    employee.clock_id !== null
    && employee.clock_id !== undefined
    && String(employee.clock_id).trim()
    && employee.status === 'active'
    && !fileClockIds.has(clockKey(employee.clock_id))
  ));

  const dates = dateRange(parsed.dateFrom, parsed.dateTo);
  const matchedPlans = matched.map((fileEmployee) => {
    const assignments = assignmentsByEmployee.get(String(fileEmployee.employee.id)) || [];
    const days = dates.map((date) => {
      const assignment = assignmentForDate(assignments, date);
      const scheduled = assignment ? shiftWorksOn(assignment, date) : false;
      const punches = (fileEmployee.records[date] || []).slice();
      let action = null;
      if (punches.length) action = 'import';
      else if (scheduled) action = 'incomplete';
      if (!action) return null;

      const existing = existingKeys.has(`${fileEmployee.employee.id}:${date}`);
      stats.recordsToWrite += 1;
      if (existing) stats.existingToOverwrite += 1;
      if (action === 'incomplete' || punches.length % 2 === 1) stats.incompleteDays += 1;
      if (punches.length) {
        stats.daysWithRecords += 1;
      } else {
        stats.missingScheduledDays += 1;
      }
      return { date, punches, scheduled, action, existing, assignment };
    }).filter(Boolean);
    return { ...fileEmployee, days };
  });

  const missingPlans = missing.map((employee) => {
    const assignments = assignmentsByEmployee.get(String(employee.id)) || [];
    const days = dates.map((date) => {
      const assignment = assignmentForDate(assignments, date);
      if (!assignment || !shiftWorksOn(assignment, date)) return null;
      const existing = existingKeys.has(`${employee.id}:${date}`);
      stats.recordsToWrite += 1;
      stats.incompleteDays += 1;
      stats.missingScheduledDays += 1;
      if (existing) stats.existingToOverwrite += 1;
      return { date, punches: [], scheduled: true, action: 'incomplete', existing, assignment };
    }).filter(Boolean);
    return { employee, days };
  });

  stats.matchedCount = matched.length;
  stats.unmatchedCount = unmatched.length;
  stats.inactiveCount = inactive.length;
  stats.missingCount = missing.length;

  return { matched: matchedPlans, missing: missingPlans, unmatched, inactive, stats };
}

module.exports = {
  MAX_EMPLOYEES,
  MAX_PUNCHES,
  MAX_RANGE_DAYS,
  isISODate,
  normalizeTime,
  dateRange,
  rangeLength,
  parseAttendanceFile,
  planAttendanceImport,
};
