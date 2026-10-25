'use strict';

const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function timeToMinutes(value) {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})/);
  if (!match) return 0;
  return Number(match[1]) * 60 + Number(match[2]);
}

function shiftDurationMinutes(startTime, endTime) {
  let start = timeToMinutes(startTime);
  let end = timeToMinutes(endTime);
  if (end <= start) end += 24 * 60;
  return Math.max(0, end - start);
}

function shiftDays(shift) {
  return String(shift && shift.work_days ? shift.work_days : '')
    .split(',')
    .map((day) => day.trim())
    .filter(Boolean);
}

function shiftWorksOn(shift, dateISO) {
  const date = new Date(`${dateISO}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return false;
  return shiftDays(shift).includes(WEEKDAY_KEYS[date.getUTCDay()]);
}

function scheduledWindow(dateISO, startTime, endTime) {
  const start = new Date(`${dateISO}T${String(startTime || '00:00:00').slice(0, 8)}Z`);
  let end = new Date(`${dateISO}T${String(endTime || '00:00:00').slice(0, 8)}Z`);
  if (end.getTime() <= start.getTime()) {
    end = new Date(end.getTime() + 24 * 60 * 60 * 1000);
  }
  return {
    start,
    end,
    duration: Math.max(0, Math.round((end.getTime() - start.getTime()) / 60000)),
  };
}

function assignmentForDate(assignments, dateISO) {
  return (assignments || [])
    .filter((assignment) => {
      const from = String(assignment.effective_from || '').slice(0, 10);
      const to = assignment.effective_to ? String(assignment.effective_to).slice(0, 10) : null;
      return from <= dateISO && (!to || to >= dateISO);
    })
    .sort((a, b) => String(b.effective_from).localeCompare(String(a.effective_from)))[0] || null;
}

function parsePunchDate(value) {
  if (value instanceof Date) return value;
  const raw = String(value === undefined || value === null ? '' : value).trim();
  if (!raw) return new Date(Number.NaN);
  // The application stores and compares attendance times as UTC. Database
  // datetime strings have no zone, so add Z before parsing.
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(raw)) {
    return new Date(`${raw.replace(' ', 'T')}Z`);
  }
  return new Date(raw);
}

function computeAttendanceFromPunches({ workDate, punches, assignment }) {
  const values = Array.isArray(punches) ? punches : [];
  const dates = values
    .map((value) => parsePunchDate(value))
    .filter((date) => !Number.isNaN(date.getTime()))
    .sort((a, b) => a.getTime() - b.getTime());
  if (values.length && dates.length !== values.length) return null;

  const punchCount = dates.length;
  const complete = punchCount >= 2 && punchCount % 2 === 0;
  let workedMinutes = null;
  if (punchCount >= 2) {
    workedMinutes = 0;
    for (let index = 0; index + 1 < punchCount; index += 2) {
      workedMinutes += Math.max(0, Math.round((dates[index + 1].getTime() - dates[index].getTime()) / 60000));
    }
  }

  const clockIn = punchCount ? dates[0] : null;
  const lastCompletedIndex = Math.floor(punchCount / 2) * 2 - 1;
  const clockOut = lastCompletedIndex >= 0 ? dates[lastCompletedIndex] : null;
  const clockInIso = clockIn ? clockIn.toISOString() : null;
  const clockOutIso = clockOut ? clockOut.toISOString() : null;

  if (!assignment) {
    return {
      shift_id: null,
      shift_name: null,
      scheduled_start: null,
      scheduled_end: null,
      expected_minutes: 0,
      worked_minutes: workedMinutes,
      late_minutes: 0,
      early_leave_minutes: 0,
      overtime_minutes: complete ? (workedMinutes || 0) : 0,
      grace_minutes: 0,
      early_leave_grace_minutes: 0,
      punctuality: complete ? 'unscheduled' : 'incomplete',
      clock_in: clockInIso,
      clock_out: clockOutIso,
      punch_count: punchCount,
    };
  }

  const window = scheduledWindow(workDate, assignment.start_time, assignment.end_time);
  const isWorkDay = shiftWorksOn(assignment, workDate);
  const grace = Number(
    assignment.grace_minutes_override !== null && assignment.grace_minutes_override !== undefined
      ? assignment.grace_minutes_override
      : assignment.grace_minutes,
  ) || 0;
  const earlyGrace = Number(
    assignment.early_leave_grace_minutes_override !== null && assignment.early_leave_grace_minutes_override !== undefined
      ? assignment.early_leave_grace_minutes_override
      : assignment.early_leave_grace_minutes,
  ) || 0;

  let lateMinutes = 0;
  let earlyLeaveMinutes = 0;
  let overtimeMinutes = 0;
  if (complete && isWorkDay) {
    lateMinutes = Math.max(0, Math.round((clockIn.getTime() - window.start.getTime()) / 60000));
    earlyLeaveMinutes = Math.max(0, Math.round((window.end.getTime() - clockOut.getTime()) / 60000));
    overtimeMinutes = Math.max(0, Math.round((clockOut.getTime() - window.end.getTime()) / 60000));
  } else if (complete) {
    overtimeMinutes = workedMinutes || 0;
  }

  let punctuality;
  if (!complete) {
    punctuality = 'incomplete';
  } else if (!isWorkDay) {
    punctuality = 'day_off';
  } else if (lateMinutes > grace && earlyLeaveMinutes > earlyGrace) {
    punctuality = 'late_early';
  } else if (lateMinutes > grace) {
    punctuality = 'late';
  } else if (earlyLeaveMinutes > earlyGrace) {
    punctuality = 'early_leave';
  } else {
    punctuality = 'on_time';
  }

  return {
    shift_id: assignment.shift_id || null,
    shift_name: assignment.shift_name || null,
    scheduled_start: assignment.start_time || null,
    scheduled_end: assignment.end_time || null,
    expected_minutes: isWorkDay ? window.duration : 0,
    worked_minutes: workedMinutes,
    late_minutes: lateMinutes,
    early_leave_minutes: earlyLeaveMinutes,
    overtime_minutes: overtimeMinutes,
    grace_minutes: grace,
    early_leave_grace_minutes: earlyGrace,
    punctuality,
    clock_in: clockInIso,
    clock_out: clockOutIso,
    punch_count: punchCount,
  };
}

function computeAttendance({ workDate, clockIn, clockOut, assignment }) {
  return computeAttendanceFromPunches({
    workDate,
    punches: [clockIn, clockOut].filter(Boolean),
    assignment,
  });
}

module.exports = {
  WEEKDAY_KEYS,
  timeToMinutes,
  shiftDurationMinutes,
  shiftDays,
  shiftWorksOn,
  scheduledWindow,
  assignmentForDate,
  computeAttendance,
  computeAttendanceFromPunches,
};
