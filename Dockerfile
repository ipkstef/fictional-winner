# Use Python 3.9 slim image as base
FROM python:3.9-slim

# Set working directory
WORKDIR /app

# Copy requirements file
COPY requirements.txt .

# Install dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy the application code and database
COPY app.py .
# COPY scryfall.db .
COPY templates/ templates/

# Expose port 5000
EXPOSE 5000

# Command to run the application
CMD ["python", "app.py"]