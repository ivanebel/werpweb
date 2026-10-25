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

function computeAttendance({ workDate, clockIn, clockOut, assignment }) {
  const inDate = new Date(clockIn);
  const outDate = clockOut ? new Date(clockOut) : null;
  if (Number.isNaN(inDate.getTime())) return null;
  if (outDate && Number.isNaN(outDate.getTime())) return null;

  const workedMinutes = outDate
    ? Math.max(0, Math.round((outDate.getTime() - inDate.getTime()) / 60000))
    : null;

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
      overtime_minutes: workedMinutes || 0,
      grace_minutes: 0,
      early_leave_grace_minutes: 0,
      punctuality: workedMinutes === null ? 'incomplete' : 'unscheduled',
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

  const lateMinutes = isWorkDay
    ? Math.max(0, Math.round((inDate.getTime() - window.start.getTime()) / 60000))
    : 0;
  const earlyLeaveMinutes = isWorkDay && outDate
    ? Math.max(0, Math.round((window.end.getTime() - outDate.getTime()) / 60000))
    : 0;
  const overtimeMinutes = outDate
    ? Math.max(0, Math.round((outDate.getTime() - window.end.getTime()) / 60000))
    : 0;

  let punctuality;
  if (workedMinutes === null) {
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
    overtime_minutes: isWorkDay ? overtimeMinutes : (workedMinutes || 0),
    grace_minutes: grace,
    early_leave_grace_minutes: earlyGrace,
    punctuality,
  };
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
};
