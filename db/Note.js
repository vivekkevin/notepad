const mongoose = require('mongoose');

const NoteSchema = new mongoose.Schema({
  title:     { type: String, default: 'Untitled' },
  content:   { type: String, default: '' },
  color:     { type: String, default: '#1a1e28' },  // card background color
  pinned:    { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

NoteSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('Note', NoteSchema);